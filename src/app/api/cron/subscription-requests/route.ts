import { isUatMode } from "@/lib/uat-safety";
import { timingSafeEqual } from "node:crypto";
import { dispatchSubscriptionRequestMail } from "@/lib/subscription-request-mail";
import { dispatchSubscriptionReviewMail } from "@/lib/subscription-review-mail";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function GET(request: Request) {
  if (isUatMode()) return Response.json({ error: "This operation is unavailable in UAT." }, { status: 403 });
  const secret = process.env.MAM_SUBSCRIPTION_REQUEST_CRON_SECRET?.trim();
  const expected = Buffer.from(`Bearer ${secret ?? ""}`);
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  if (!secret || expected.length !== supplied.length || !timingSafeEqual(expected,supplied)) return Response.json({ ok:false }, { status:401 });
  const deadline = Date.now() + 260_000;
  const submissions = await dispatchSubscriptionRequestMail();
  const reviews = await dispatchSubscriptionReviewMail(deadline);
  const result = { ok: submissions.ok && reviews.ok, submissions, reviews };
  return Response.json(result, { status:result.ok ? 200 : 503, headers:{ "Cache-Control":"no-store" } });
}
