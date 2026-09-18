import "server-only";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { normalizeAllowlistPhone } from "./openclaw-allowlist";

// Protocol logic is shared by the route and synthetic transaction tests.
export const LEAVE_BRIDGE_PATH = "/api/internal/integrations/openclaw/leave";
const TYPES = ["Annual leave", "Sick leave", "Carer's leave", "Unpaid leave"];
const ID = /^[A-Za-z0-9:_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const TTL = 10 * 60_000;
type ObjectValue = Record<string, unknown>;
type Identity = { account: string; sender: string; session: string };
export type LeaveFields = {
  leaveType: string; startDate: string; endDate: string;
  startTime: string | null; endTime: string | null; employeeNote: string;
};
export type Employee = {
  personId: string; userId: string | null; company: string; active: boolean;
  nodeKind: string; accountActive: boolean; phone: string | null; country: string | null;
  employmentType: string | null;
};
export type LeaveDraft = {
  id: string; identity: Identity; personId: string; userId: string;
  fields: LeaveFields; summary: string; digest: string; challenge: string;
  expiresAt: number; shownMessageId?: string; shownAt?: number;
  result?: { requestId: string; status: "Pending" };
};
export type BridgeResult = {
  code: "needs_input" | "prepared" | "shown" | "submitted";
  missing?: string[]; draftId?: string; summary?: string; digest?: string;
  expiresAt?: string; requestId?: string; status?: "Pending";
};
/** All methods execute in ONE serializable database transaction. No network
 * calls, emails or in-memory production persistence inside this boundary.
 * Concurrent/retried event keys must serialize; rollback includes the leave,
 * draft, replay receipt and existing notification outbox together. */
export interface LeaveTransaction {
  // Complete authoritative snapshot: never a paginated/allowlist-cache subset.
  employees(): Promise<{ complete: true; rows: Employee[] }>;
  receipt(key: string): Promise<{ fingerprint: string; personId: string; userId: string; result: BridgeResult } | null>;
  saveReceipt(key: string, fingerprint: string, employee: Employee, result: BridgeResult): Promise<void>;
  draft(id: string): Promise<LeaveDraft | null>;
  saveDraft(draft: LeaveDraft): Promise<void>;
  // Internal ONLY: actor is server-resolved, never accepted from HTTP/MCP input.
  // Reuse existing validation, employment policy, reviewer routing, Pending
  // status and notification outbox; never selected-profile/admin impersonation.
  // Reject overlapping active leave; enforce DB uniqueness on draftId.
  submitSelf(employee: Employee, fields: LeaveFields, draftId: string): Promise<{ requestId: string; status: "Pending" }>;
}
export interface LeaveStore {
  transaction<T>(work: (tx: LeaveTransaction) => Promise<T>, context: { key: string; fingerprint: string; packet: ObjectValue }): Promise<T>;
}
class ContractError extends Error {
  constructor(readonly code: "invalid_request" | "unauthorized" | "not_available" | "conflict" | "expired") { super(code); }
}
const fail = (code: ContractError["code"]): never => { throw new ContractError(code); };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid_request");
  return value as ObjectValue;
}
function exact(value: ObjectValue, keys: string[]) {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) fail("invalid_request");
}
function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) return fail("invalid_request");
  return value;
}
function date(value: unknown): string {
  const s = text(value, /^\d{4}-\d{2}-\d{2}$/);
  const d = new Date(s + "T00:00:00Z");
  if (!Number.isFinite(+d) || d.toISOString().slice(0, 10) !== s || s < "2000-01-01" || s > "2100-12-31") fail("invalid_request");
  return s;
}
function fields(value: unknown): LeaveFields | { missing: string[] } {
  const v = object(value);
  const allowed = ["leaveType", "startDate", "endDate", "startTime", "endTime", "employeeNote"];
  if (Object.keys(v).some(k => !allowed.includes(k))) fail("invalid_request");
  const missing = ["leaveType", "startDate", "endDate"].filter(k => v[k] === undefined || v[k] === "");
  if (missing.length) return { missing };
  if (typeof v.leaveType !== "string" || !TYPES.includes(v.leaveType)) fail("invalid_request");
  const startDate = date(v.startDate), endDate = date(v.endDate);
  const days = (+new Date(endDate) - +new Date(startDate)) / 86400000;
  if (days < 0 || days + 1 > 366) fail("invalid_request");
  const time = (s: unknown) => s === undefined || s === null || s === "" ? null : text(s, /^(0[6-9]|1[0-7]):(00|15|30|45)$|^18:00$/);
  const startTime = time(v.startTime), endTime = time(v.endTime);
  if ((startTime === null) !== (endTime === null)) return { missing: [startTime === null ? "startTime" : "endTime"] };
  const weekday = (s: string) => new Date(s).getUTCDay() % 6 !== 0;
  if (startTime && endTime && (!weekday(startDate) || !weekday(endDate) || startTime === "18:00" || endTime === "06:00" || (days === 0 && endTime <= startTime))) fail("invalid_request");
  if (days < 2 && !weekday(startDate) && !weekday(endDate)) fail("invalid_request");
  if (v.employeeNote !== undefined && typeof v.employeeNote !== "string") fail("invalid_request");
  const employeeNote = (v.employeeNote as string | undefined)?.trim() ?? "";
  // Control/bidi characters cannot visually hide altered confirmation fields.
  if (employeeNote.length > 2000 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(employeeNote)) fail("invalid_request");
  return { leaveType: v.leaveType as string, startDate, endDate, startTime, endTime, employeeNote };
}
function summary(input: LeaveFields, employee: Employee, challenge: string) {
  let days = 0;
  for (let d = +new Date(input.startDate); d <= +new Date(input.endDate); d += 86400000) {
    if (new Date(d).getUTCDay() % 6 !== 0) days++;
  }
  const duration = input.startTime && input.endTime
    ? `${input.startDate} ${input.startTime} to ${input.endDate} ${input.endTime} (Australia/Melbourne; portal 06:00–18:00 weekday window)`
    : `${days} working day(s)${employee.employmentType === "full_time" ? ` / ${(days * 7.6).toFixed(2)} hours` : ""}`;
  return ["Submit leave for yourself (not yet submitted)", `Type: ${input.leaveType}`,
    `Dates: ${input.startDate} to ${input.endDate}`, `Duration: ${duration}`,
    `Note (literal text): ${JSON.stringify(input.employeeNote)}`,
    "Requires manager approval. No balance is included.",
    `Reply to this exact message with CONFIRM ${challenge} within 10 minutes to submit.`].join("\n");
}
function sameIdentity(a: Identity, b: Identity) { return a.account === b.account && a.sender === b.sender && a.session === b.session; }
async function resolve(tx: LeaveTransaction, sender: string) {
  const snapshot = await tx.employees();
  if (snapshot.complete !== true || !Array.isArray(snapshot.rows) || snapshot.rows.length > 10000) return fail("not_available");
  // Count BEFORE filtering portal eligibility: a shared active MAM number with
  // an unlinked/disabled account is still ambiguous, not a reason to pick one.
  const matches = snapshot.rows.filter(p => p.active && p.company === "mam" && normalizeAllowlistPhone(p.phone, p.country) === sender);
  if (matches.length !== 1) return fail("not_available");
  const p = matches[0];
  if (p.nodeKind !== "person" || !p.accountActive || !p.userId || !UUID.test(p.userId) || !UUID.test(p.personId)) return fail("not_available");
  return p;
}
function eligible(employee: Employee, input: LeaveFields) {
  if (!["full_time", "part_time"].includes(employee.employmentType ?? "") && input.leaveType !== "Unpaid leave") fail("not_available");
}

/** The native adapter signs exact UTF-8 bytes, never model-provided identity.
 * Signature: hex HMAC-SHA256(key, `POST\n<path>\n<timestamp>\n<rawBody>`).
 * Do NOT expose a signing/confirm tool to the model. Missing adapter config
 * fails closed. No Supabase credential is exposed through this contract. */
export async function handleLeaveBridge(
  rawBody: string, timestamp: string, signature: string,
  config: { key: string; account: string }, store: LeaveStore, now = Date.now(),
): Promise<{ status: number; body: BridgeResult | { code: string } }> {
  try {
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(config.key) || !ID.test(config.account)) return { status: 503, body: { code: "unavailable" } };
    if (Buffer.byteLength(rawBody, "utf8") > 16384 || !/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 60000 || !DIGEST.test(signature)) fail("unauthorized");
    const expected = createHmac("sha256", config.key).update(`POST\n${LEAVE_BRIDGE_PATH}\n${timestamp}\n${rawBody}`).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) fail("unauthorized");
    let parsed: unknown;
    try { parsed = JSON.parse(rawBody); } catch { return fail("invalid_request"); }
    const packet = object(parsed);
    exact(packet, ["version", "account", "channel", "sender", "session", "eventId", "operation", "payload"]);
    if (packet.version !== 1 || packet.channel !== "whatsapp" || packet.account !== config.account) fail("unauthorized");
    const identity = { account: config.account, sender: text(packet.sender, /^\+[1-9][0-9]{7,14}$/), session: text(packet.session, ID) };
    if (normalizeAllowlistPhone(identity.sender) !== identity.sender) fail("unauthorized");
    const eventId = text(packet.eventId, ID);
    const payload = object(packet.payload);
    if (!["prepare", "shown", "confirm"].includes(packet.operation as string)) fail("invalid_request");
    const key = hash(JSON.stringify([identity.account, identity.sender, eventId]));
    const fingerprint = hash(rawBody);
    const result = await store.transaction(async tx => {
      const employee = await resolve(tx, identity.sender);
      const previous = await tx.receipt(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint || previous.personId !== employee.personId || previous.userId !== employee.userId) return fail("conflict");
        return previous.result;
      }
      let result: BridgeResult;
      if (packet.operation === "prepare") {
        const input = fields(payload);
        if ("missing" in input) result = { code: "needs_input", missing: input.missing };
        else {
          eligible(employee, input);
          const id = randomUUID(), challenge = randomUUID();
          const display = summary(input, employee, challenge);
          const draft: LeaveDraft = { id, identity, personId: employee.personId, userId: employee.userId!, fields: input,
            summary: display, digest: hash(display), challenge, expiresAt: now + TTL };
          await tx.saveDraft(draft);
          result = { code: "prepared", draftId: id, summary: display, digest: draft.digest, expiresAt: new Date(draft.expiresAt).toISOString() };
        }
      } else {
        exact(payload, packet.operation === "shown" ? ["draftId", "digest", "outboundMessageId"] : ["draftId", "digest", "replyToMessageId", "text"]);
        const draft = await tx.draft(text(payload.draftId, UUID));
        if (!draft || !sameIdentity(identity, draft.identity) || draft.personId !== employee.personId || draft.userId !== employee.userId) return fail("not_available");
        if (text(payload.digest, DIGEST) !== draft.digest) return fail("conflict");
        // Expiry prevents NEW submissions, not receipt retrieval for a leave
        // already committed. Identity/digest/quoted consent still bind retries.
        if (draft.expiresAt <= now && !(packet.operation === "confirm" && draft.result)) return fail("expired");
        if (!draft.result) eligible(employee, draft.fields);
        if (packet.operation === "shown") {
          const messageId = text(payload.outboundMessageId, ID);
          if (draft.shownMessageId && draft.shownMessageId !== messageId) return fail("conflict");
          if (draft.result) return fail("conflict");
          draft.shownMessageId = messageId;
          draft.shownAt ??= now;
          result = { code: "shown" };
        } else {
          if (!draft.shownMessageId || draft.shownAt === undefined || now <= draft.shownAt || payload.replyToMessageId !== draft.shownMessageId || payload.text !== `CONFIRM ${draft.challenge}`) return fail("conflict");
          // Recompute the rendered summary on employment changes; never submit
          // with different displayed hours/policy without a fresh confirmation.
          if (!draft.result && hash(summary(draft.fields, employee, draft.challenge)) !== draft.digest) return fail("conflict");
          draft.result ??= await tx.submitSelf(employee, draft.fields, draft.id);
          if (draft.result.status !== "Pending" || !UUID.test(draft.result.requestId)) return fail("not_available");
          result = { code: "submitted", ...draft.result };
        }
        await tx.saveDraft(draft);
      }
      await tx.saveReceipt(key, fingerprint, employee, result);
      return result;
    }, { key, fingerprint, packet });
    return { status: 200, body: result };
  } catch (error) {
    if (error instanceof ContractError) return { status: error.code === "unauthorized" ? 401 : error.code === "invalid_request" ? 400 : 409, body: { code: error.code } };
    // Never leak employee matches, leave notes, SQL messages or key material.
    return { status: 503, body: { code: "unavailable" } };
  }
}
