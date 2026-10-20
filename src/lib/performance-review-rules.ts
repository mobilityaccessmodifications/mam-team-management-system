import { Temporal } from "temporal-polyfill";
import type { PerformanceDocument, PerformanceWorkspace, PerformanceReview, PerformanceStartInput, PerformanceReconcileInput, PerformanceMeeting, PerformanceMutationInput } from "@/lib/performance-review-types";

export const REQUIRED_ANSWERS = [0, 3, 4, 5, 6, 7, 8, 9, 10];
export const RATING_INDICES = [0, 1, 2, 6, 7, 8, 9];
export const RATINGS = ["1 Needs improvement", "2 Meets expectations", "3 Exceeds expectations", "N Not enough evidence"];
type RecordValue = Record<string, unknown>;
function invalid(): never { throw new Error("Invalid performance review data."); }
export function closed(value: unknown, keys: readonly string[]): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(k => typeof k !== "string" || !keys.includes(k) || !Object.hasOwn(descriptors[k], "value"))) invalid();
  return value as RecordValue;
}
export function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) invalid();
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length > 8000 || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/.test(value)) invalid();
  return value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 12 || Reflect.ownKeys(value).length !== 13) invalid();
  for (let i = 0; i < 12; i++) if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, String(i)) ?? {}, "value")) invalid();
  return value.map(text);
}
export function parseMutationInput(value: unknown): PerformanceMutationInput {
  const v = closed(value, ["operationId", "reviewId", "expectedRevision", "command", "input"]);
  uuid(v.operationId); uuid(v.reviewId);
  const self = v.command === "save_self" || v.command === "submit_self";
  const manager = v.command === "save_manager" || v.command === "complete_manager";
  const meeting = v.command === "save_meeting" || v.command === "submit_review";
  if (meeting) {
    if (typeof v.expectedRevision !== "string" || !/^(?:manager|read):(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.test(v.expectedRevision)) invalid();
    const m = closed(v.input, v.command === "submit_review" ? [...MEETING_KEYS, "held"] : MEETING_KEYS);
    if (v.command === "submit_review" && m.held !== true) invalid();
    validateMeeting(m);
    return structuredClone(v) as PerformanceMutationInput;
  }
  if ((!self && !manager) || typeof v.expectedRevision !== "string" || !(self ? /^self:(0|[1-9][0-9]*)$/ : /^(?:manager|read):(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/).test(v.expectedRevision)) invalid();
  const input = closed(v.input, self ? ["answers"] : ["answers", "ratings", "summary", "overallRating", "managerNote"]);
  const answers = strings(input.answers);
  if (v.command === "submit_self") for (const i of REQUIRED_ANSWERS) if (!answers[i].trim()) invalid();
  if (manager) {
    const ratings = strings(input.ratings);
    if (ratings.some(r => r !== "" && !RATINGS.includes(r)) || (text(input.overallRating) !== "" && !RATINGS.includes(input.overallRating as string))) invalid();
    text(input.summary); text(input.managerNote);
  }
  return structuredClone(v) as PerformanceMutationInput;
}
const MEETING_KEYS = ["date", "time", "duration", "mode", "location", "notes"];
function date(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith("0000")) invalid();
  try { if (Temporal.PlainDate.from(value, { overflow: "reject" }).toString() !== value) invalid(); } catch { invalid(); }
  return value;
}
function validateMeeting(m: RecordValue) {
  date(m.date);
  if (typeof m.time !== "string" || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(m.time) || !Number.isInteger(m.duration) || (m.duration as number) < 5 || (m.duration as number) > 480 || !["in_person", "teams", "phone"].includes(m.mode as string) || !text(m.location).trim()) invalid();
  text(m.notes);
  if (m.mode === "teams") {
    try {
      const url = new URL(m.location as string);
      if (url.protocol !== "https:" || !["teams.microsoft.com", "teams.live.com"].includes(url.hostname) || url.username || url.password) invalid();
    } catch { invalid(); }
  }
  meetingEndMillis(m as PerformanceMeeting);
}
export function meetingEndMillis(meeting: PerformanceMeeting): number {
  date(meeting.date);
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(meeting.time)) invalid();
  try {
    return Temporal.ZonedDateTime.from(`${meeting.date}T${meeting.time}[Australia/Melbourne]`, { disambiguation: "reject", overflow: "reject" }).epochMilliseconds + meeting.duration * 60000;
  } catch { return invalid(); }
}
export function parseStartInput(value: unknown): PerformanceStartInput {
  const v = closed(value, ["operationId", "employeePersonId", "cycle", "dueDate"]);
  uuid(v.operationId); uuid(v.employeePersonId); date(v.dueDate);
  if (typeof v.cycle !== "string" || !/^[0-9]{4}$/.test(v.cycle)) invalid();
  return structuredClone(v) as PerformanceStartInput;
}
export function parseReconcileInput(value: unknown): PerformanceReconcileInput {
  const v = closed(value, ["operationId", "reviewId"]);
  uuid(v.operationId); if (v.reviewId !== null) uuid(v.reviewId);
  return structuredClone(v) as PerformanceReconcileInput;
}
const SELF_KEYS = ["id", "code", "employee", "manager", "cycle", "dueDate", "selfStatus", "selfAnswers", "selfSubmittedAt", "selfRevision", "selfActivity", "audience", "capabilities"];
const MANAGER_KEYS = ["managerAnswers", "ratings", "summary", "overallRating", "managerNote", "managerCompletedAt", "meeting", "meetingHeldAt", "finalisedAt", "managerActivity"];
const MANAGER_CAPS = ["saveSelf", "submitSelf", "saveManager", "completeManager", "saveMeeting", "submitReview", "downloadDocument"];
function identity(value: unknown) {
  const v = closed(value, ["id", "name", "jobTitle", "company", "team"]);
  uuid(v.id); text(v.name); text(v.jobTitle); text(v.team);
  if (!["MAM", "Equipsy"].includes(v.company as string) || !(v.name as string).trim()) invalid();
}
function managerIdentity(value: unknown) {
  const v = closed(value, ["id", "name"]); uuid(v.id); if (!text(v.name).trim()) invalid();
}
function timestamp(value: unknown, nullable = true) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) invalid();
}
function activity(value: unknown) {
  if (!Array.isArray(value)) invalid();
  for (const event of value) { const e = closed(event, ["kind", "at"]); text(e.kind); timestamp(e.at, false); }
}
export function parseReview(value: unknown, readOnly = false): PerformanceReview {
  if (!value || typeof value !== "object") invalid();
  const audience = Object.getOwnPropertyDescriptor(value, "audience")?.value;
  if (!["employee", "manager", "admin"].includes(audience)) invalid();
  const v = closed(value, audience === "employee" ? SELF_KEYS : [...SELF_KEYS, ...MANAGER_KEYS, audience === "manager" ? "managerRevision" : "readRevision"]);
  uuid(v.id); identity(v.employee); managerIdentity(v.manager);
  if (typeof v.code !== "string" || !/^PR-[0-9]{4}-[1-9][0-9]*$/.test(v.code) || typeof v.cycle !== "string" || !/^[0-9]{4}$/.test(v.cycle)) invalid();
  date(v.dueDate); strings(v.selfAnswers); timestamp(v.selfSubmittedAt); activity(v.selfActivity);
  if (v.selfStatus !== (v.selfSubmittedAt === null ? "awaiting_employee" : "manager_review") || typeof v.selfRevision !== "string" || !/^self:(0|[1-9][0-9]*)$/.test(v.selfRevision)) invalid();
  const caps = closed(v.capabilities, audience === "employee" ? ["saveSelf", "submitSelf", "downloadDocument"] : MANAGER_CAPS);
  if (Object.values(caps).some(c => typeof c !== "boolean")) invalid();
  if (readOnly && Object.entries(caps).some(([key, enabled]) => key !== "downloadDocument" && enabled !== false)) invalid();
  if (audience === "employee") {
    if (!readOnly && (caps.saveSelf !== (v.selfSubmittedAt === null) || caps.submitSelf !== caps.saveSelf)) invalid();
  } else {
    strings(v.managerAnswers); const ratings = strings(v.ratings);
    if (ratings.some(r => r !== "" && !RATINGS.includes(r)) || (text(v.overallRating) !== "" && !RATINGS.includes(v.overallRating as string))) invalid();
    text(v.summary); text(v.managerNote);
    timestamp(v.managerCompletedAt); timestamp(v.meetingHeldAt); timestamp(v.finalisedAt);
    if (v.meeting !== null) validateMeeting(closed(v.meeting, MEETING_KEYS));
    activity(v.managerActivity);
    const token = v[audience === "manager" ? "managerRevision" : "readRevision"];
    if (typeof token !== "string" || !(audience === "manager" ? /^manager:(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/ : /^read:(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/).test(token) || token.split(":")[1] !== v.selfRevision.split(":")[1] || caps.saveSelf !== false || caps.submitSelf !== false) invalid();
  }
  return structuredClone(v) as PerformanceReview;
}
export function parseWorkspace(value: unknown, actorUserId: string, role: string, personId: string | null, readOnly: boolean | "manager_delegate" = false): PerformanceWorkspace {
  const v = closed(value, ["viewerContext", "reviews", "startablePeople"]);
  const viewer = closed(v.viewerContext, ["actorUserId", "personId", "role", "displayName"]);
  if (viewer.actorUserId !== actorUserId || viewer.role !== role || viewer.personId !== personId) invalid();
  text(viewer.displayName);
  if (!Array.isArray(v.reviews) || !Array.isArray(v.startablePeople) || (!["manager", "admin", "system_admin"].includes(role) && v.startablePeople.length)) invalid();
  if (readOnly === "manager_delegate" && role !== "manager") invalid();
  const ids = new Set();
  for (const raw of v.reviews) {
    const audience = raw && typeof raw === "object" ? Object.getOwnPropertyDescriptor(raw, "audience")?.value : undefined;
    const review = parseReview(raw, readOnly === "manager_delegate" ? audience !== "manager" : readOnly);
    if (ids.has(review.id)) invalid(); ids.add(review.id);
    if (review.employee.id === personId) { if (review.audience !== "employee") invalid(); }
    else if (role === "admin" || role === "system_admin") { if (review.audience !== "admin") invalid(); }
    else if (role !== "manager" || review.audience !== "manager" || review.manager.id !== personId) invalid();
  }
  const people = new Set();
  for (const person of v.startablePeople) {
    identity(person);
    if (people.has(person.id) || person.id === personId) invalid();
    people.add(person.id);
  }
  return structuredClone(v) as PerformanceWorkspace;
}
export function parseDocument(value: unknown): PerformanceDocument {
  if (!value || typeof value !== "object") invalid();
  const audience = Object.getOwnPropertyDescriptor(value, "audience")?.value;
  if (!["employee", "manager", "admin"].includes(audience)) invalid();
  const common = ["audience", "code", "cycle", "employee", "manager", "selfAnswers"];
  const v = closed(value, audience === "employee" ? common : [...common, "managerAnswers", "ratings", "summary", "overallRating", "meeting"]);
  identity(v.employee); managerIdentity(v.manager); strings(v.selfAnswers);
  if (typeof v.code !== "string" || !/^PR-[0-9]{4}-[1-9][0-9]*$/.test(v.code) || typeof v.cycle !== "string" || !/^[0-9]{4}$/.test(v.cycle)) invalid();
  if (audience !== "employee") {
    strings(v.managerAnswers); const ratings = strings(v.ratings);
    if (ratings.some(r => r !== "" && !RATINGS.includes(r)) || (text(v.overallRating) !== "" && !RATINGS.includes(v.overallRating as string))) invalid();
    text(v.summary); if (v.meeting !== null) validateMeeting(closed(v.meeting, MEETING_KEYS));
  }
  return structuredClone(v) as PerformanceDocument;
}
