import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { isUatMode } from "@/lib/uat-safety";

const STORAGE_PATH_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:pdf|heic|heif|jpg|png|webp)$/i;
const PAYROLL_ARCHIVE_PATH_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:csv|xlsx)$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ORPHAN_BATCHES = 8;
const MAX_PAYROLL_ARCHIVE_BATCHES = 8;

function orphanPath(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const path = (value as Record<string, unknown>).storage_path;
  return typeof path === "string" && STORAGE_PATH_PATTERN.test(path) ? path : null;
}

function deletedCount(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function payrollArchive(value: unknown): { archiveId: string; storagePath: string; wasUploaded: boolean } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const archiveId = row.archive_id;
  const storagePath = row.storage_path;
  const wasUploaded = row.was_uploaded;
  if (typeof archiveId !== "string" || !UUID_PATTERN.test(archiveId)
    || typeof storagePath !== "string" || !PAYROLL_ARCHIVE_PATH_PATTERN.test(storagePath)
    || typeof wasUploaded !== "boolean") return null;
  return { archiveId, storagePath, wasUploaded };
}

/**
 * Bounded private-storage maintenance. PostgreSQL identifies only generated,
 * two-hour-old orphan paths; deletion itself always goes through the Storage
 * API. Metadata retention is pruned by separate service-role-only RPCs.
 */
export async function runLeaveAttachmentMaintenance() {
  if (isUatMode()) throw new Error("This operation is unavailable in UAT.");
  const admin = createAdminClient();
  let removedObjects = 0;
  let cleanupBatches = 0;
  for (; cleanupBatches < MAX_ORPHAN_BATCHES; cleanupBatches += 1) {
    const { data: orphanData, error: orphanError } = await admin.rpc(
      "list_stale_leave_attachment_orphans",
    );
    if (orphanError || !Array.isArray(orphanData)) {
      throw new Error("Attachment orphan discovery failed.");
    }

    const orphanPaths = orphanData.map(orphanPath);
    if (orphanPaths.some((path) => path === null)) {
      throw new Error("Attachment orphan discovery returned an invalid path.");
    }
    const paths = orphanPaths.filter((path): path is string => Boolean(path));
    if (!paths.length) break;

    const { data: removed, error: removalError } = await admin.storage
      .from("leave-evidence")
      .remove(paths);
    if (removalError) throw new Error("Attachment orphan deletion failed.");
    if (!Array.isArray(removed) || removed.length !== paths.length) {
      throw new Error("Attachment orphan deletion was incomplete.");
    }
    removedObjects += removed.length;
  }

  let removedPayrollSourceFiles = 0;
  let prunedPayrollArchiveRecords = 0;
  let payrollArchiveBatches = 0;
  for (; payrollArchiveBatches < MAX_PAYROLL_ARCHIVE_BATCHES; payrollArchiveBatches += 1) {
    const { data: archiveData, error: archiveError } = await admin.rpc(
      "list_expired_payroll_balance_source_archives",
    );
    if (archiveError || !Array.isArray(archiveData)) {
      throw new Error("Payroll source archive discovery failed.");
    }
    const archives = archiveData.map(payrollArchive);
    if (archives.some((archive) => archive === null)) {
      throw new Error("Payroll source archive discovery returned an invalid record.");
    }
    const validArchives = archives.filter((archive): archive is NonNullable<typeof archive> => Boolean(archive));
    if (!validArchives.length) break;

    const { data: removed, error: removalError } = await admin.storage
      .from("payroll-balance-archives")
      .remove(validArchives.map((archive) => archive.storagePath));
    if (removalError) throw new Error("Payroll source archive deletion failed.");
    const expectedObjects = validArchives.filter((archive) => archive.wasUploaded).length;
    if (!Array.isArray(removed)) throw new Error("Payroll source archive deletion was incomplete.");
    if (removed.length < expectedObjects) {
      // A previous run may have deleted objects before its database commit
      // failed. Finalise only after Storage confirms every object is absent.
      // Network, permission and generic 400 errors are not proof of absence.
      const checks = await Promise.all(validArchives.map(async (archive) => {
        const [folder, name] = archive.storagePath.split("/");
        const result = await admin.storage.from("payroll-balance-archives")
          .list(folder, { search: name, limit: 100 });
        return !result.error && Array.isArray(result.data)
          && !result.data.some((entry) => entry.name === name);
      }));
      if (!checks.every(Boolean)) throw new Error("Payroll source archive deletion was incomplete.");
    }

    const completed = await admin.rpc("complete_payroll_balance_source_archive_deletion", {
      p_archive_ids: validArchives.map((archive) => archive.archiveId),
    });
    if (completed.error || deletedCount(completed.data) !== validArchives.length) {
      throw new Error("Payroll source archive retention could not be finalised.");
    }
    removedPayrollSourceFiles += removed.length;
    prunedPayrollArchiveRecords += validArchives.length;
  }

  const [intents, attempts] = await Promise.all([
    admin.rpc("prune_expired_leave_attachment_upload_intents"),
    admin.rpc("prune_expired_leave_attachment_upload_attempts"),
  ]);
  if (intents.error || attempts.error) {
    throw new Error("Attachment metadata retention failed.");
  }

  return {
    cleanupBatches,
    removedObjects,
    payrollArchiveBatches,
    removedPayrollSourceFiles,
    prunedPayrollArchiveRecords,
    prunedIntents: deletedCount(intents.data),
    prunedAttempts: deletedCount(attempts.data),
  };
}
