import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

const STORAGE_PATH_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:pdf|heic|heif|jpg|png|webp)$/i;
const MAX_ORPHAN_BATCHES = 8;

function orphanPath(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const path = (value as Record<string, unknown>).storage_path;
  return typeof path === "string" && STORAGE_PATH_PATTERN.test(path) ? path : null;
}

function deletedCount(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * Bounded private-storage maintenance. PostgreSQL identifies only generated,
 * two-hour-old orphan paths; deletion itself always goes through the Storage
 * API. Metadata retention is pruned by separate service-role-only RPCs.
 */
export async function runLeaveAttachmentMaintenance() {
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
    prunedIntents: deletedCount(intents.data),
    prunedAttempts: deletedCount(attempts.data),
  };
}
