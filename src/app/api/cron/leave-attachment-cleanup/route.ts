import { timingSafeEqual } from "node:crypto";

import { runLeaveAttachmentMaintenance } from "@/lib/leave-attachment-maintenance";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function hasValidCronSecret(request: Request, secret: string) {
  const candidate = request.headers.get("authorization");
  const expected = `Bearer ${secret}`;
  if (!candidate) return false;
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return candidateBytes.length === expectedBytes.length
    && timingSafeEqual(candidateBytes, expectedBytes);
}

/** Daily, CRON_SECRET-gated cleanup for expired private file retention. */
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret || !hasValidCronSecret(request, cronSecret)) {
    return Response.json({ ok: false, code: "unauthorized" }, {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

  try {
    const result = await runLeaveAttachmentMaintenance();
    return Response.json({ ok: true, ...result }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({ ok: false, code: "maintenance_failed" }, {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
