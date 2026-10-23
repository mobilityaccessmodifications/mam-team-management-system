import { timingSafeEqual } from "node:crypto";
import { dispatchEmployeeLifecycleMail } from "@/lib/employee-lifecycle-mail";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret ?? ""}`);
  const headers = { "Cache-Control": "no-store" };
  if (!secret || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return Response.json({ ok: false, code: "unauthorized" }, { status: 401, headers });
  try {
    const result = await dispatchEmployeeLifecycleMail();
    return Response.json(result, { status: result.ok ? 200 : 503, headers });
  } catch { return Response.json({ ok: false, code: "unavailable" }, { status: 503, headers }); }
}
