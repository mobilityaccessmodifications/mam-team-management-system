import "server-only";
import { timingSafeEqual } from "node:crypto";
import { Temporal } from "temporal-polyfill";
import { closed, parseMutationInput, uuid } from "@/lib/performance-review-rules";
import { performanceMailBudget, performanceMailRpcSucceeded, performanceReviewMailEnabled, readPerformanceMailJson } from "@/lib/performance-review-mail-policy";

const PATH = "/api/performance-reviews/meeting";
const AI = "ai@mobilityaccess.com.au";
const REQUEST_KEYS = ["requestToken", "reviewId", "reviewCode", "expectedRevision", "requestedAt", "managerEmail", "employeeEmail"];
const EVENT_KEYS = ["id", "uid", "subject", "organizer", "attendees", "start", "end", "createdAt", "modifiedAt", "mode", "location", "isCancelled", "isAllDay", "type"];

export type MeetingImportRpc = (name: string, args: Record<string, unknown>, signal: AbortSignal) => PromiseLike<{ data: unknown; error: unknown; status?: unknown }>;

function invalid(): never { throw new Error("invalid_request"); }
function text(value: unknown, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f\ufffe\uffff]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) invalid();
  return value;
}
function email(value: unknown): string {
  const result = text(value, 254);
  if (result !== result.trim().toLowerCase() || !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(result)) invalid();
  return result;
}
function instant(value: unknown, utc = false): Temporal.Instant {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?(?:Z|[+-]\d\d:\d\d)$/.test(value) || value.startsWith("0000") || (utc && !value.endsWith("Z"))) invalid();
  try { return Temporal.Instant.from(value); } catch { return invalid(); }
}
function revision(value: unknown): string {
  if (typeof value !== "string" || !/^manager:(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.test(value)) invalid();
  return value;
}

export function parseMeetingImportRequests(raw: unknown) {
  if (!Array.isArray(raw) || raw.length > 1000) invalid();
  const tokens = new Set<string>();
  const reviews = new Set<string>();
  return raw.map(value => {
    const row = closed(value, REQUEST_KEYS);
    const requestToken = uuid(row.requestToken), reviewId = uuid(row.reviewId);
    if (tokens.has(requestToken) || reviews.has(reviewId) || typeof row.reviewCode !== "string" || !/^PR-[0-9]{4}-[1-9][0-9]*$/.test(row.reviewCode)) invalid();
    tokens.add(requestToken); reviews.add(reviewId);
    instant(row.requestedAt);
    return { requestToken, reviewId, reviewCode: row.reviewCode, expectedRevision: revision(row.expectedRevision), requestedAt: row.requestedAt as string, managerEmail: email(row.managerEmail), employeeEmail: email(row.employeeEmail) };
  });
}

export function parseMeetingImportInput(raw: unknown) {
  const input = closed(raw, ["requestToken", "expectedRevision", "event"]);
  const requestToken = uuid(input.requestToken), expectedRevision = revision(input.expectedRevision);
  const event = closed(input.event, EVENT_KEYS);
  text(event.id, 1024); text(event.uid, 1024); text(event.subject, 1024); email(event.organizer);
  if (event.isCancelled !== false || event.isAllDay !== false || event.type !== "singleInstance" || !Array.isArray(event.attendees) || event.attendees.length < 1 || event.attendees.length > 32) invalid();
  const attendees = event.attendees.map(email);
  if (new Set(attendees).size !== attendees.length || !attendees.includes(AI)) invalid();
  if (((event.subject as string).match(/(?:^|[^A-Za-z0-9_-])(PR-[0-9]{4}-[1-9][0-9]*)(?=$|[^A-Za-z0-9_-])/g) ?? []).length !== 1) invalid();
  const start = instant(event.start, true), end = instant(event.end, true);
  const created = instant(event.createdAt, true), modified = instant(event.modifiedAt, true);
  if (start.epochMilliseconds % 60000 || end.epochMilliseconds % 60000 || start.epochNanoseconds % BigInt(1000000) !== BigInt(0) || end.epochNanoseconds % BigInt(1000000) !== BigInt(0) || Temporal.Instant.compare(created, modified) > 0) invalid();
  const duration = (end.epochMilliseconds - start.epochMilliseconds) / 60000;
  const local = start.toZonedDateTimeISO("Australia/Melbourne");
  const meeting = { date: local.toPlainDate().toString(), time: `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`, duration, mode: event.mode, location: text(event.location, 8000), notes: "" };
  parseMutationInput({ operationId: requestToken, reviewId: requestToken, expectedRevision, command: "save_meeting", input: meeting });
  return { requestToken, expectedRevision, event: structuredClone(event) };
}

function reply(body: object, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store, max-age=0" } });
}
function authenticates(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim(), supplied = request.headers.get("authorization");
  if (!secret || secret.length < 32 || secret.length > 512 || !supplied || supplied.length > 520) return false;
  const actual = Buffer.from(supplied), expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function enabled() {
  return process.env.MAM_PERFORMANCE_REVIEW_ENABLED === "true" && performanceReviewMailEnabled();
}

export async function handlePerformanceMeetingRequest(request: Request, rpc: MeetingImportRpc) {
  if (!authenticates(request)) return reply({ ok: false, code: "unauthorized" }, 401);
  let url: URL;
  try {
    url = new URL(request.url);
    const origin = process.env.NEXT_PUBLIC_APP_URL;
    if (!origin || url.origin !== origin || url.pathname !== PATH || url.username || url.password || url.hash
      || (request.headers.has("origin") && request.headers.get("origin") !== origin)
      || (url.search && !(request.method === "GET" && url.search === "?readiness=1"))) invalid();
  } catch { return reply({ ok: false, code: "invalid_request" }, 400); }
  if (!enabled()) return reply({ ok: false, code: "unavailable" }, 503);
  const budget = performanceMailBudget();
  if (request.method === "GET") {
    if (url.search) return reply({ ok: true, ready: true });
    try {
      const result = await budget.run(signal => rpc("list_performance_review_meeting_imports", { p_limit: 1001 }, signal));
      if (!performanceMailRpcSucceeded(result) || !enabled() || !authenticates(request)) throw Error("unavailable");
      return reply({ ok: true, requests: parseMeetingImportRequests(result.data) });
    } catch { return reply({ ok: false, code: "unavailable" }, 503); }
  }
  if (request.method !== "POST") return reply({ ok: false, code: "invalid_request" }, 405);
  let input: ReturnType<typeof parseMeetingImportInput>;
  try { input = parseMeetingImportInput(await budget.run(signal => readPerformanceMailJson(request, 32768, signal))); }
  catch { return reply({ ok: false, code: "invalid_request" }, 400); }
  try {
    if (!enabled() || !authenticates(request)) throw Error("unavailable");
    const result = await budget.run(signal => rpc("import_performance_review_meeting", { p_request_token: input.requestToken, p_expected_revision: input.expectedRevision, p_event: input.event }, signal));
    if (!performanceMailRpcSucceeded(result)) {
      if (result.status !== undefined && typeof result.status === "number" && result.status < 500 && result.error && typeof result.error === "object" && "code" in result.error && result.error.code === "22023") return reply({ ok: false, code: "invalid_request" }, 400);
      throw Error("unavailable");
    }
    const body = closed(result.data, ["status"]);
    if (!["imported", "already_imported", "skipped"].includes(body.status as string)) throw Error("unavailable");
    return reply({ ok: true, status: body.status });
  } catch { return reply({ ok: false, code: "unavailable" }, 503); }
}
