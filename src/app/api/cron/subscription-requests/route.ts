import { timingSafeEqual } from "node:crypto";
import { dispatchSubscriptionRequestMail } from "@/lib/subscription-request-mail";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function GET(request: Request) {
  const secret = process.env.MAM_SUBSCRIPTION_REQUEST_CRON_SECRET?.trim();
  const expected = Buffer.from(`Bearer ${secret ?? ""}`);
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  if (!secret || expected.length !== supplied.length || !timingSafeEqual(expected,supplied)) return Response.json({ ok:false }, { status:401 });
  const result = await dispatchSubscriptionRequestMail();
  return Response.json(result, { status:result.ok ? 200 : 503, headers:{ "Cache-Control":"no-store" } });
}
