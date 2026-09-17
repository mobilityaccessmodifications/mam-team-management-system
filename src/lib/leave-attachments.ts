export const MAX_LEAVE_ATTACHMENTS = 10;
const MAX_LEAVE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const LEAVE_ATTACHMENT_MIME_TYPES = new Set([
  "application/pdf",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
export const LEAVE_ATTACHMENT_ACCEPT = "application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif";

export function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function validateLeaveAttachmentFiles(files: File[], existingCount = 0) {
  if (files.length + existingCount > MAX_LEAVE_ATTACHMENTS) {
    return `A leave request can have up to ${MAX_LEAVE_ATTACHMENTS} supporting files.`;
  }
  const unsupported = files.find((file) => !LEAVE_ATTACHMENT_MIME_TYPES.has(file.type.toLowerCase()));
  if (unsupported) return `${unsupported.name || "That file"} is not a supported PDF or image file.`;
  const empty = files.find((file) => file.size < 1);
  if (empty) return `${empty.name || "That file"} is empty.`;
  const oversized = files.find((file) => file.size > MAX_LEAVE_ATTACHMENT_BYTES);
  if (oversized) return `${oversized.name || "That file"} is larger than 5 MB.`;
  const unsafeName = files.find((file) => !file.name.trim() || file.name.length > 255 || /[\\/\u0000-\u001f]/u.test(file.name));
  if (unsafeName) return "One supporting file has an unsupported name. Rename it and try again.";
  return "";
}
