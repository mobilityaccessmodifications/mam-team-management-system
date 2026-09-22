import { timingSafeEqual } from "node:crypto";
import { dispatchLeaveNotificationOutbox, dispatchPayrollComparisonAlerts } from "@/lib/leave-notification-outbox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  const expected = Buffer.from(`Bearer ${secret ?? ""}`);
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const reply = (body: object, status: number) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (!secret || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return reply({ ok: false }, 401);
  try {
    const result = await dispatchLeaveNotificationOutbox();
    const comparisons = await dispatchPayrollComparisonAlerts();
    return reply({ ...result, comparisons }, result.ok && comparisons.ok ? 200 : 503);
  } catch { return reply({ ok: false, code: "dispatch_failed" }, 503); }
}
