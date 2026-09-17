import "server-only";

import type { PreparedPayrollBalanceFile } from "@/lib/payroll-balance-import";
import { createAdminClient } from "@/lib/supabase/admin";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORAGE_PATH_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:csv|xlsx)$/i;

type ArchivePlan = {
  archiveId: string;
  storagePath: string;
};

function archivePlan(value: unknown): ArchivePlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The payroll source archive could not be prepared.");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.archiveId !== "string" || !UUID_PATTERN.test(row.archiveId)
    || typeof row.storagePath !== "string" || !STORAGE_PATH_PATTERN.test(row.storagePath)) {
    throw new Error("The payroll source archive returned an invalid path.");
  }
  return { archiveId: row.archiveId, storagePath: row.storagePath };
}

/**
 * Stores the raw source bytes before parsing. The database creates the private
 * retention record first, so a parser or completion failure cannot shorten the
 * file's thirty-day recovery window.
 */
export async function archivePayrollBalanceFiles(
  actorUserId: string,
  files: PreparedPayrollBalanceFile[],
): Promise<string[]> {
  if (!UUID_PATTERN.test(actorUserId)) throw new Error("The payroll source archive actor is invalid.");
  const admin = createAdminClient();
  const archiveIds: string[] = [];

  for (const file of files) {
    const prepared = await admin.rpc("prepare_payroll_balance_source_archive", {
      p_actor_user_id: actorUserId,
      p_original_file_name: file.name,
      p_content_type: file.mimeType,
      p_size_bytes: file.sizeBytes,
      p_source_sha256: file.sha256,
    });
    if (prepared.error || !prepared.data) throw new Error("The payroll source archive could not be prepared.");
    const plan = archivePlan(prepared.data);
    archiveIds.push(plan.archiveId);

    const uploaded = await admin.storage.from("payroll-balance-archives").upload(
      plan.storagePath,
      file.buffer,
      { cacheControl: "0", contentType: file.mimeType, upsert: false },
    );
    if (uploaded.error) throw new Error("The payroll source file could not be archived.");

    const completed = await admin.rpc("complete_payroll_balance_source_archive", {
      p_actor_user_id: actorUserId,
      p_archive_id: plan.archiveId,
    });
    if (completed.error) throw new Error("The payroll source archive could not be completed.");
  }

  return archiveIds;
}

export async function markPayrollBalanceSourceArchivesFailed(actorUserId: string, archiveIds: string[]) {
  const { error } = await createAdminClient().rpc("mark_payroll_balance_source_archives_failed", {
    p_actor_user_id: actorUserId,
    p_archive_ids: archiveIds,
  });
  if (error) throw new Error("The payroll source archive failure state could not be recorded.");
}

export async function linkPayrollBalanceSourceArchives(
  actorUserId: string,
  archiveIds: string[],
  batchId: string,
) {
  const { error } = await createAdminClient().rpc("link_payroll_balance_source_archives", {
    p_actor_user_id: actorUserId,
    p_archive_ids: archiveIds,
    p_batch_id: batchId,
  });
  if (error) throw new Error("The payroll source archives could not be linked to the import batch.");
}
