import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

type DownloadTarget = {
  storage_path?: unknown;
  file_name?: unknown;
  mime_type?: unknown;
};

function unavailable() {
  // Do not disclose whether an attachment exists, belongs to another person,
  // or is no longer available to this session.
  return new NextResponse(null, {
    status: 404,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function contentDisposition(fileName: string) {
  const fallback = fileName
    .replace(/[\r\n"\\]/g, "_")
    .replace(/[^\x20-\x7e]/g, "_")
    .slice(0, 180) || "supporting-file";
  const encoded = encodeURIComponent(fileName).replace(/[!'()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export const runtime = "nodejs";

/**
 * Private attachment download boundary. The browser only has an attachment ID;
 * this route re-checks the session and database authorisation, then uses the
 * server-only admin client to resolve the private object. It produces a
 * 60-second upstream signed URL and streams a forced-download response. It
 * never exposes a Storage path or a reusable public URL to the workspace.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ attachmentId: string }> },
) {
  try {
    const { attachmentId } = await params;
    if (!UUID_PATTERN.test(attachmentId)) return unavailable();

    const supabase = await createClient();
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) return unavailable();

    const { data: isAllowed, error: authorisationError } = await supabase.rpc(
      "can_download_leave_request_attachment",
      { p_attachment_id: attachmentId },
    );
    if (authorisationError || isAllowed !== true) return unavailable();

    const admin = createAdminClient();
    const { data: target, error: targetError } = await admin
      .from("leave_request_attachments")
      .select("storage_path, file_name, mime_type")
      .eq("id", attachmentId)
      .maybeSingle<DownloadTarget>();
    if (
      targetError
      || typeof target?.storage_path !== "string"
      || typeof target.file_name !== "string"
      || typeof target.mime_type !== "string"
      || !ALLOWED_MIME_TYPES.has(target.mime_type)
    ) return unavailable();

    const { data: signedUrl, error: signError } = await admin.storage
      .from("leave-evidence")
      .createSignedUrl(target.storage_path, 60);
    if (signError || !signedUrl?.signedUrl) return unavailable();

    const upstream = await fetch(signedUrl.signedUrl, {
      cache: "no-store",
      headers: { "Cache-Control": "no-store" },
    });
    if (!upstream.ok || !upstream.body) return unavailable();

    return new NextResponse(upstream.body, {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Disposition": contentDisposition(target.file_name),
        "Content-Type": target.mime_type,
        "Cross-Origin-Resource-Policy": "same-origin",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return unavailable();
  }
}
