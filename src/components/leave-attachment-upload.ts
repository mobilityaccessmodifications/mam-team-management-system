import { completeLeaveRequestAttachmentUpload, discardLeaveRequestAttachmentUpload, prepareLeaveRequestAttachmentUpload } from "@/app/leave/actions";
import type { createClient } from "@/lib/supabase/client";

/** Upload sequentially so each private storage intent is completed or discarded. */
export async function uploadLeaveAttachments(directorySupabase: ReturnType<typeof createClient> | null, requestId: string, files: File[]) {
  if (!directorySupabase) return { uploaded: 0, failed: files.map((file) => file.name || "supporting file") };
  const failed: string[] = [];
  let uploaded = 0;
  for (const file of files) {
    let storagePath: string | undefined;
    try {
      const plan = await prepareLeaveRequestAttachmentUpload({
        requestId,
        fileName: file.name,
        mimeType: file.type.toLowerCase(),
        sizeBytes: file.size,
      });
      storagePath = plan.storagePath;
      const { error: storageError } = await directorySupabase.storage
        .from("leave-evidence")
        .upload(plan.storagePath, file, {
          cacheControl: "0",
          contentType: plan.mimeType,
          upsert: false,
        });
      if (storageError) throw new Error("Storage upload failed.");
      await completeLeaveRequestAttachmentUpload({ storagePath: plan.storagePath });
      uploaded += 1;
    } catch {
      if (storagePath) {
        try {
          await discardLeaveRequestAttachmentUpload({ storagePath });
        } catch {
          // A retention job removes any unregistered private object if the
          // upload reached Storage before registration failed.
        }
      }
      failed.push(file.name || "supporting file");
    }
  }
  return { uploaded, failed };
}
