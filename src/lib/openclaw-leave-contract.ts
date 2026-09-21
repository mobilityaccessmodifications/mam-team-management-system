import "server-only";
import { createHash, createHmac, randomUUID, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";
import { normalizeAllowlistPhone } from "./openclaw-allowlist";
import { LEAVE_NOTICE_MESSAGE, requiresLeaveNotice } from "./leave-notice";

// Protocol logic is shared by the route and synthetic transaction tests.
export const LEAVE_BRIDGE_PATH = "/api/internal/integrations/openclaw/leave";
const TYPES = ["Annual leave", "Sick leave", "Carer's leave", "Unpaid leave"];
const EMPLOYMENT_TYPES = ["abn", "casual", "full_time", "part_time"];
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
  employmentType: string | null; fullName?: string | null;
};
export type SelfProfileEmployee = Employee & { fullName: string | null };
export type SelfProfile = { name: string; employmentType: string | null };
export type LeaveDraft = {
  id: string; identity: Identity; personId: string; userId: string;
  fields: LeaveFields; summary: string; digest: string; challenge: string;
  consentVersion: 3; employmentType: string | null; fullName: string;
  issuedAt: number;
  expiresAt: number; shownMessageId?: string; shownAt?: number;
  result?: { requestId: string; status: "Pending" };
};
export type BridgeResult = {
  code: "profile" | "needs_input" | "prepared" | "shown" | "submitted";
  profile?: SelfProfile;
  missing?: string[]; draftId?: string; summary?: string; digest?: string;
  expiresAt?: string; requestId?: string; status?: "Pending";
  consentVersion?: 3; draftToken?: string;
  availableLeaveTypes?: string[]; instruction?: string;
};
export type LeaveSnapshot = {
  complete: true; rows: Employee[]; fingerprint: string;
  receipt: { fingerprint: string; personId: string; userId: string; result: BridgeResult } | null;
  submitted: { identity: Identity; personId: string; userId: string; tokenHash: string; result: { requestId: string; status: "Pending" } } | null;
};
export interface LeaveStore {
  // Both calls re-read authoritative employees. Preparation invokes ONLY snapshot.
  snapshot(key: string, draftId: string | null): Promise<LeaveSnapshot>;
  // Only confirmation reaches this atomic persistence boundary.
  submit(plan: { key: string; fingerprint: string; sourceFingerprint: string; packet: ObjectValue;
    employee: Employee; draft: LeaveDraft; tokenHash: string }): Promise<BridgeResult>;
}
type EmployeeSource<T extends Employee> = {
  employees(): Promise<{ complete: true; rows: T[] }>;
};
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
function fields(value: unknown, employee?: Employee, now = Date.now()): LeaveFields | { missing: string[]; availableLeaveTypes?: string[]; instruction?: string } {
  let v = object(value);
  const allowed = ["leaveType", "startDate", "endDate", "startTime", "endTime", "employeeNote"];
  if (Object.keys(v).some(k => !allowed.includes(k))) fail("invalid_request");
  let availableLeaveTypes: string[] | undefined;
  if (employee) {
    if (!EMPLOYMENT_TYPES.includes(employee.employmentType ?? "")) fail("not_available");
    availableLeaveTypes = ["casual", "abn"].includes(employee.employmentType!) ? ["Unpaid leave"] : TYPES;
    // Resolve eligibility here, without exporting a separate personal profile
    // to the model. Never silently rewrite an explicitly requested paid type.
    if ((v.leaveType === undefined || v.leaveType === "") && availableLeaveTypes.length === 1) v = { ...v, leaveType: "Unpaid leave" };
    else if (typeof v.leaveType === "string" && TYPES.includes(v.leaveType) && !availableLeaveTypes.includes(v.leaveType)) {
      return { missing: ["leaveType"], availableLeaveTypes, instruction: "That leave type is not available. Ask whether the employee wants Unpaid leave instead; do not silently change their choice." };
    }
  }
  // Check as soon as type and start are known, even before an end date/time.
  // Identity/classification came from the signed sender's authoritative lookup,
  // never from model-selected fields. Reuse the portal's calendar-day policy.
  if (employee && typeof v.leaveType === "string" && TYPES.includes(v.leaveType)
    && v.startDate !== undefined && v.startDate !== "") {
    const startDate = date(v.startDate);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
    if (requiresLeaveNotice({ employmentType: employee.employmentType, leaveType: v.leaveType, startDate, onBehalfOf: false }, today)) {
      return { missing: [], instruction: `${LEAVE_NOTICE_MESSAGE} Explain this to the employee in English. This request is blocked: do not collect more details, send a confirmation summary, ask for Confirm, or claim submission. Do not change the dates or leave type to bypass the rule. Only prepare again if the employee explicitly changes their request. You cannot log leave on their behalf or grant an exception.` };
    }
  }
  const missing = ["leaveType", "startDate", "endDate"].filter(k => v[k] === undefined || v[k] === "");
  if (missing.length) return { missing, ...(availableLeaveTypes && missing.includes("leaveType") ? { availableLeaveTypes } : {}) };
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
function summary(input: LeaveFields, employee: Employee) {
    const name = profile({ ...employee, fullName: employee.fullName ?? null }).name;
    const dates = input.startDate === input.endDate ? input.startDate : `${input.startDate} to ${input.endDate}`;
    return ["Please review your leave request:", `Name: ${name}`, `Dates: ${dates}`,
      ...(input.startTime && input.endTime ? [`Times: ${input.startTime} to ${input.endTime} (Australia/Melbourne)`] : []),
      `Type: ${input.leaveType}`, `Note (optional): ${input.employeeNote || "None"}`].join("\n");
}
function sameIdentity(a: Identity, b: Identity) { return a.account === b.account && a.sender === b.sender && a.session === b.session; }
async function resolve<T extends Employee>(tx: EmployeeSource<T>, sender: string): Promise<T> {
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
function profile(employee: SelfProfileEmployee): SelfProfile {
  const name = typeof employee.fullName === "string" ? employee.fullName.trim() : "";
  if (!name || name.length > 200 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(name)) fail("not_available");
  if (employee.employmentType !== null && !EMPLOYMENT_TYPES.includes(employee.employmentType)) fail("not_available");
  return { name, employmentType: employee.employmentType };
}
function eligible(employee: Employee, input: LeaveFields) {
  if (!["full_time", "part_time"].includes(employee.employmentType ?? "") && input.leaveType !== "Unpaid leave") fail("not_available");
}

const TOKEN_DOMAIN = "mam-openclaw-leave:v3:draft:aes-256-gcm";
function tokenKey(secret: string) { return createHmac("sha256", secret).update(TOKEN_DOMAIN).digest(); }
function seal(draft: LeaveDraft, secret: string) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", tokenKey(secret), iv);
  cipher.setAAD(Buffer.from(TOKEN_DOMAIN));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(draft), "utf8"), cipher.final()]);
  return `v3.${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
}
function unseal(value: unknown, secret: string): LeaveDraft {
  const token = text(value, /^v3\.[A-Za-z0-9_-]{40,15000}$/);
  try {
    const bytes = Buffer.from(token.slice(3), "base64url");
    if (bytes.toString("base64url") !== token.slice(3)) return fail("invalid_request");
    const cipher = createDecipheriv("aes-256-gcm", tokenKey(secret), bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(TOKEN_DOMAIN)); cipher.setAuthTag(bytes.subarray(12, 28));
    const d = object(JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8")));
    exact(d, ["id", "identity", "personId", "userId", "fields", "summary", "digest", "challenge", "consentVersion", "employmentType", "fullName", "issuedAt", "expiresAt"]);
    if (d.consentVersion !== 3 || !Number.isSafeInteger(d.issuedAt) || !Number.isSafeInteger(d.expiresAt) || Number(d.expiresAt) - Number(d.issuedAt) !== TTL) return fail("invalid_request");
    text(d.id, UUID); text(d.personId, UUID); text(d.userId, UUID); text(d.challenge, UUID); text(d.digest, DIGEST);
    const identity = object(d.identity); exact(identity, ["account", "sender", "session"]);
    text(identity.account, ID); text(identity.session, ID); text(identity.sender, /^\+[1-9][0-9]{7,14}$/);
    if (typeof d.summary !== "string" || hash(d.summary) !== d.digest || typeof d.fullName !== "string") return fail("invalid_request");
    const parsed = fields(d.fields);
    if ("missing" in parsed || JSON.stringify(parsed) !== JSON.stringify(d.fields)) return fail("invalid_request");
    return d as unknown as LeaveDraft;
  } catch { return fail("invalid_request"); }
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
    // Retired versions must not create persistent preparation/display records.
    if (packet.version !== 3) return { status: 409, body: { code: "restart_required" } };
    if (packet.channel !== "whatsapp" || packet.account !== config.account) fail("unauthorized");
    const identity = { account: config.account, sender: text(packet.sender, /^\+[1-9][0-9]{7,14}$/), session: text(packet.session, ID) };
    if (normalizeAllowlistPhone(identity.sender) !== identity.sender) fail("unauthorized");
    const eventId = text(packet.eventId, ID);
    const payload = object(packet.payload);
    if (!["prepare", "confirm"].includes(packet.operation as string)) fail("invalid_request");
    const key = hash(JSON.stringify([identity.account, identity.sender, eventId]));
    const fingerprint = hash(rawBody);
    let draft: LeaveDraft | null = null;
    if (packet.operation === "confirm") {
      exact(payload, ["draftToken", "shownMessageId", "replyToMessageId", "text"]);
      draft = unseal(payload.draftToken, config.key);
      if (!sameIdentity(identity, draft.identity)) fail("not_available");
      text(payload.shownMessageId, ID);
      if (payload.replyToMessageId !== null && payload.replyToMessageId !== payload.shownMessageId) fail("conflict");
      if (typeof payload.text !== "string" || !/^[ \t\r\n]*confirm[ \t\r\n]*$/i.test(payload.text)) fail("conflict");
      if (draft.issuedAt > now) fail("conflict");
    }
    const snapshot = await store.snapshot(key, draft?.id ?? null);
    const employee = await resolve({ employees: async () => snapshot }, identity.sender);
    if (!draft) {
      const input = fields(payload, employee, now);
      if ("missing" in input) return { status: 200, body: { code: "needs_input", ...input } };
      eligible(employee, input);
      const display = summary(input, employee);
      const prepared: LeaveDraft = { id: randomUUID(), identity, personId: employee.personId, userId: employee.userId!,
        fields: input, summary: display, digest: hash(display), challenge: randomUUID(), consentVersion: 3,
        employmentType: employee.employmentType, fullName: profile({ ...employee, fullName: employee.fullName ?? null }).name,
        issuedAt: now, expiresAt: now + TTL };
      const draftToken = seal(prepared, config.key);
      // Ensure the maximum legitimate confirm envelope still fits the route cap.
      if (draftToken.length > 14000) fail("invalid_request");
      return { status: 200, body: { code: "prepared", consentVersion: 3, draftId: prepared.id, summary: display,
        digest: prepared.digest, expiresAt: new Date(prepared.expiresAt).toISOString(), draftToken } };
    }
    if (draft.personId !== employee.personId || draft.userId !== employee.userId) fail("not_available");
    const previous = snapshot.receipt;
    if (previous && (previous.fingerprint !== fingerprint || previous.personId !== employee.personId || previous.userId !== employee.userId)) fail("conflict");
    const tokenHash = hash(payload.draftToken as string);
    const submitted = snapshot.submitted;
    if (submitted && (submitted.tokenHash !== tokenHash || submitted.personId !== employee.personId || submitted.userId !== employee.userId || !sameIdentity(submitted.identity, identity))) fail("conflict");
    if (!previous && !submitted) {
      if (draft.expiresAt <= now) fail("expired");
      if (draft.employmentType !== employee.employmentType || draft.fullName !== profile({ ...employee, fullName: employee.fullName ?? null }).name || summary(draft.fields, employee) !== draft.summary) fail("conflict");
      eligible(employee, draft.fields);
    }
    // Even a replay goes through the locked source-CAS transaction; never return
    // a cached result after only a stale/unlocked identity read.
    const result = await store.submit({ key, fingerprint, sourceFingerprint: snapshot.fingerprint, packet, employee, draft, tokenHash });
    return { status: 200, body: result };
  } catch (error) {
    if (error instanceof ContractError) return { status: error.code === "unauthorized" ? 401 : error.code === "invalid_request" ? 400 : 409, body: { code: error.code } };
    // Never leak employee matches, leave notes, SQL messages or key material.
    return { status: 503, body: { code: "unavailable" } };
  }
}
