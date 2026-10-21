import "server-only";
import { timingSafeEqual } from "node:crypto";

const PATH = "/api/performance-reviews/meeting";
function invalid(): never { throw new Error("invalid_request"); }

function reply(body: object, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store, max-age=0" } });
}
function authenticates(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim(), supplied = request.headers.get("authorization");
  if (!secret || secret.length < 32 || secret.length > 512 || !supplied || supplied.length > 520) return false;
  const actual = Buffer.from(supplied), expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export async function handlePerformanceMeetingRequest(request: Request) {
  if (!authenticates(request)) return reply({ ok: false, code: "unauthorized" }, 401);
  try {
    const url = new URL(request.url);
    const origin = process.env.NEXT_PUBLIC_APP_URL;
    if (!origin || url.origin !== origin || url.pathname !== PATH || url.username || url.password || url.hash
      || (request.headers.has("origin") && request.headers.get("origin") !== origin)
      || (url.search && !(request.method === "GET" && url.search === "?readiness=1"))) invalid();
  } catch { return reply({ ok: false, code: "invalid_request" }, 400); }
  return reply({ ok: false, code: "manual_entry_required" }, 410);
}
