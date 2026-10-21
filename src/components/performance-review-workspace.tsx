"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { mutatePerformanceReview, startPerformanceReview, getPerformanceReviewDocument, reconcilePerformanceReviewOperation } from "@/app/performance-reviews/actions";
import { loadPerformanceReviews, loadPerformanceReviewMeetingInvitationStatus } from "@/lib/performance-review-load";
import { buildPerformanceReviewDownload } from "@/lib/performance-review-document";
import { createClient } from "@/lib/supabase/client";
import { meetingEndMillis } from "@/lib/performance-review-rules";
import { QUESTIONS } from "@/lib/performance-review-questions.mjs";
import type { PerformanceFailure, PerformanceReview, PerformanceSelfReview, PerformanceManagerInput, PerformanceIdentity, PerformanceMeeting, PerformanceMutationInput, PerformanceWorkspace } from "@/lib/performance-review-types";
import toolbar from "./people-toolbar.module.css";
import styles from "./performance-review-workspace.module.css";

const REQUIRED = [0, 3, 4, 5, 6, 7, 8, 9, 10];
const RATED = [0, 1, 2, 6, 7, 8, 9];
const RATINGS = [["1 Needs improvement", "1 Needs improvement"], ["2 Meets expectations", "2 Meets expectations"], ["3 Exceeds expectations", "3 Exceeds expectations"], ["N Not enough evidence", "N Not enough evidence"]];
type DraftChannel = "self" | "assessment" | "meeting";
type PendingOperation = { operationId: string; reviewId: string | null; phase: "pending" | "uncertain"; draft?: { channel: DraftChannel; version: number } };
type ConflictScope = { generation: number; actorUserId: string; personId: string | null; role: PerformanceWorkspace["viewerContext"]["role"]; reviewId: string; employeePersonId: string; audience: PerformanceReview["audience"]; command: PerformanceMutationInput["command"] };
const INVITATION_STATUS_DELAYS = [2000, 4000, 8000, 16000, 30000];
const EMPTY_MEETING: PerformanceMeeting = { date: "", time: "", duration: 30, mode: "in_person", location: "", notes: "" };

function newReviewDraft() {
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === type)!.value;
  const cycle = part("year");
  const dueDate = new Date(Date.UTC(Number(cycle), Number(part("month")) - 1, Number(part("day")) + 7)).toISOString().slice(0, 10);
  return { employeePersonId: "", cycle, dueDate };
}

function selfRow(row: PerformanceReview): PerformanceSelfReview {
  return {
    id: row.id, code: row.code, employee: { ...row.employee }, manager: { ...row.manager },
    cycle: row.cycle, dueDate: row.dueDate, selfStatus: row.selfStatus,
    selfAnswers: [...row.selfAnswers], selfSubmittedAt: row.selfSubmittedAt,
    selfRevision: row.selfRevision, selfActivity: row.selfActivity.map(event => ({ kind: event.kind, at: event.at })),
    audience: "employee", capabilities: { saveSelf: row.capabilities.saveSelf, submitSelf: row.capabilities.submitSelf, downloadDocument: row.capabilities.downloadDocument },
  };
}

function ownedRow(row: PerformanceReview, viewer: PerformanceWorkspace["viewerContext"]): PerformanceReview | null {
  if (row.audience === "employee") return ["employee", "account", "manager", "admin", "system_admin"].includes(viewer.role) && row.employee.id === viewer.personId ? selfRow(row) : null;
  if (row.audience === "manager" && (viewer.role !== "manager" || row.manager.id !== viewer.personId || row.employee.id === viewer.personId)) return null;
  if (row.audience === "admin" && (viewer.role !== "admin" && viewer.role !== "system_admin" || row.employee.id === viewer.personId)) return null;
  const fields = {
    ...selfRow(row), managerAnswers: [...row.managerAnswers], ratings: [...row.ratings],
    summary: row.summary, overallRating: row.overallRating, managerNote: row.managerNote,
    managerCompletedAt: row.managerCompletedAt, meeting: row.meeting ? { ...row.meeting } : null,
    meetingHeldAt: row.meetingHeldAt, finalisedAt: row.finalisedAt,
    managerActivity: row.managerActivity.map(event => ({ kind: event.kind, at: event.at })),
  };
  return row.audience === "manager" ? { ...fields, audience: "manager", managerRevision: row.managerRevision, capabilities: { ...row.capabilities } } : { ...fields, audience: "admin", readRevision: row.readRevision, capabilities: { ...row.capabilities } };
}

function orderedReviews(rows: PerformanceReview[]) {
  return [...rows].sort((a, b) => b.cycle.localeCompare(a.cycle) || a.dueDate.localeCompare(b.dueDate) || a.code.localeCompare(b.code));
}

function ownedWorkspace(data: PerformanceWorkspace): PerformanceWorkspace {
  return { viewerContext: { ...data.viewerContext }, reviews: orderedReviews(data.reviews.map(row => ownedRow(row, data.viewerContext)).filter((row): row is PerformanceReview => row !== null)), startablePeople: ["manager", "admin", "system_admin"].includes(data.viewerContext.role) ? data.startablePeople.filter(person => person.id !== data.viewerContext.personId).map(person => ({ ...person })) : [] };
}

function reviewPeople(data: PerformanceWorkspace | null): PerformanceIdentity[] {
  return data ? [...new Map([...data.startablePeople, ...data.reviews.map(row => row.employee)].map(person => [person.id, person])).values()] : [];
}

function managerInput(row: PerformanceReview): PerformanceManagerInput | null {
  return row.audience === "employee" ? null : { answers: [...row.managerAnswers], ratings: [...row.ratings], summary: row.summary, overallRating: row.overallRating, managerNote: row.managerNote };
}

export default function PerformanceReviewWorkspace({ previewPersonId }: { previewPersonId?: string } = {}) {
  const [workspace, setWorkspace] = useState<PerformanceWorkspace | null>(null);
  const preview = previewPersonId !== undefined;
  const readOnly = preview && (workspace?.viewerContext.role !== "manager" || workspace.viewerContext.personId !== previewPersonId);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [answers, setAnswers] = useState<string[]>([]);
  const [assessment, setAssessment] = useState<PerformanceManagerInput | null>(null);
  const [meeting, setMeeting] = useState<PerformanceMeeting>({ ...EMPTY_MEETING });
  const [held, setHeld] = useState(false);
  const heldDraft = useRef(false);
  const [startDraft, setStartDraft] = useState({ employeePersonId: "", cycle: "", dueDate: "" });
  const [startYear, setStartYear] = useState(0);
  const reviewChoice = useRef<{ employeePersonId: string; cycle: string } | null>(null);
  const [message, setMessage] = useState("");
  const [recoveryVisible, setRecoveryVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [autoSaving, setAutoSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [generation, setGeneration] = useState(0);
  const [revision, setRevision] = useState("");
  const epoch = useRef(0);
  const dirty = useRef(false);
  const dirtyParts = useRef({ self: false, assessment: false, meeting: false });
  const draftVersions = useRef({ self: 0, assessment: 0, meeting: 0 });
  const draft = useRef<{ answers: string[]; assessment: PerformanceManagerInput | null; meeting: PerformanceMeeting }>({ answers: [], assessment: null, meeting: { ...EMPTY_MEETING } });
  const currentRevision = useRef("");
  const currentReviews = useRef<PerformanceReview[]>([]);
  const autoPromise = useRef<Promise<boolean> | null>(null);
  const flush = useRef<() => Promise<boolean>>(async () => true);
  const [clock, setClock] = useState(Date.now);
  const [confirmedInvitation, setConfirmedInvitation] = useState<string | null>(null);
  const nativeActor = useRef<string | null | undefined>(undefined);
  const viewer = useRef<PerformanceWorkspace["viewerContext"] | null>(null);
  const selection = useRef<{ id: string; audience: PerformanceReview["audience"] } | null>(null);
  const busyRef = useRef(false);
  const busyOwner = useRef<symbol | null>(null);
  const operationRef = useRef<PendingOperation | null>(null);
  const conflict = useRef<ConflictScope | null>(null);
  const [operation, setOperation] = useState<PendingOperation | null>(null);
  const urls = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const retire = useCallback(() => { epoch.current += 1; }, []);
  const selected = workspace?.reviews.find(row => row.id === selectedId);
  const invitationScope = workspace && selected && selected.audience !== "employee" && !readOnly && !selected.finalisedAt && (selected.capabilities.saveManager || selected.capabilities.completeManager)
    ? JSON.stringify([workspace.viewerContext.actorUserId, workspace.viewerContext.personId, workspace.viewerContext.role, previewPersonId, selected.id, selected.audience]) : null;
  const invitationSent = invitationScope !== null && confirmedInvitation === invitationScope;
  const invitationRequested = !!selected && selected.audience !== "employee" && Boolean(selected.managerCompletedAt);
  const invitationStarted = invitationRequested || invitationSent;
  const people = reviewPeople(workspace);
  const search = query.trim().toLocaleLowerCase();
  const filteredPeople = people.filter(person => [person.name, person.jobTitle, person.team, person.company].join(" ").toLocaleLowerCase().includes(search));
  const startPerson = people.find(person => person.id === startDraft.employeePersonId);
  const creating = !selected && !!startPerson && !!workspace?.startablePeople.some(person => person.id === startPerson.id);
  const cycles = [...new Set([...(workspace?.startablePeople.some(person => person.id === startDraft.employeePersonId) ? [String(startYear - 1), String(startYear), String(startYear + 1)] : []), ...(workspace?.reviews.filter(row => row.employee.id === startDraft.employeePersonId).map(row => row.cycle) ?? [])])].sort((a, b) => b.localeCompare(a));
  const track = useCallback((next: PendingOperation | null) => { if (next) conflict.current = null; operationRef.current = next; setOperation(next); }, []);
  const advance = useCallback(() => {
    if (operationRef.current?.phase === "pending") track({ ...operationRef.current, phase: "uncertain" });
    autoPromise.current = null;
    busyOwner.current = null; busyRef.current = false; setBusy(false); setAutoSaving(false); setLoading(false);
    const next = ++epoch.current;
    if (conflict.current) conflict.current = conflict.current.generation === next - 1 ? { ...conflict.current, generation: next } : null;
    setGeneration(next); return next;
  }, [track]);
  function claimBusy() { const owner = Symbol(); busyOwner.current = owner; busyRef.current = true; setBusy(true); setMessage(""); return owner; }
  function releaseBusy(owner: symbol) { if (busyOwner.current === owner) { busyOwner.current = null; busyRef.current = false; setBusy(false); } }
  const unknown = useCallback(() => { setRecoveryVisible(true); if (operationRef.current) track({ ...operationRef.current, phase: "uncertain" }); setMessage("The update could not be confirmed. Reconcile before submitting again."); }, [track]);
  const choose = useCallback((row: PerformanceReview | null) => {
    advance(); conflict.current = null; setRecoveryVisible(false); dirty.current = false; dirtyParts.current = { self: false, assessment: false, meeting: false };
    draftVersions.current = { self: 0, assessment: 0, meeting: 0 };
    draft.current = { answers: row ? [...row.selfAnswers] : [], assessment: row ? managerInput(row) : null, meeting: !row || row.audience === "employee" ? { ...EMPTY_MEETING } : { ...(row.meeting ?? EMPTY_MEETING) } };
    selection.current = row ? { id: row.id, audience: row.audience } : null;
    currentRevision.current = row ? row.audience === "employee" ? row.selfRevision : row.audience === "manager" ? row.managerRevision : row.readRevision : "";
    setRevision(currentRevision.current);
    setSelectedId(row?.id ?? null); setAnswers(row ? [...row.selfAnswers] : []);
    setAssessment(row ? managerInput(row) : null);
    setMeeting(!row || row.audience === "employee" ? { ...EMPTY_MEETING } : { ...(row.meeting ?? EMPTY_MEETING) });
    heldDraft.current = false; setHeld(false); setMessage("");
  }, [advance]);
  const clearPrivate = useCallback((notice: string) => {
    track(null); choose(null); viewer.current = null;
    setWorkspace(null); currentReviews.current = []; setConfirmedInvitation(null); setQuery(""); reviewChoice.current = null; setStartDraft({ employeePersonId: "", cycle: "", dueDate: "" });
    for (const [url, timer] of urls.current) { clearTimeout(timer); URL.revokeObjectURL(url); }
    urls.current.clear(); setMessage(notice);
  }, [track, choose]);
  const handleFailure = useCallback((result: PerformanceFailure, writing = false) => {
    if (result.code === "unauthenticated" || result.code === "forbidden") { clearPrivate(result.message); return; }
    setRecoveryVisible(true);
    if (writing && (result.uncertain || result.code === "uncertain")) { unknown(); return; }
    if (writing) track(null);
    setMessage(result.message);
  }, [clearPrivate, unknown, track]);
  const applyLoaded = useCallback((input: PerformanceWorkspace, preferredId: string | null, recovery: ConflictScope | null = null) => {
    if (previewPersonId !== undefined && input.viewerContext.personId !== previewPersonId) { clearPrivate("Reviews could not be loaded."); return; }
    if (nativeActor.current === null || (nativeActor.current !== undefined && nativeActor.current !== input.viewerContext.actorUserId)) { clearPrivate("Your session has changed."); return; }
    const data = ownedWorkspace(input), previous = viewer.current;
    const changed = previous !== null && (previous.actorUserId !== data.viewerContext.actorUserId || previous.role !== data.viewerContext.role || previous.personId !== data.viewerContext.personId);
    if (changed) clearPrivate("");
    nativeActor.current = data.viewerContext.actorUserId;
    viewer.current = data.viewerContext; currentReviews.current = data.reviews; setWorkspace(data);
    const draft = newReviewDraft();
    setStartYear(Number(draft.cycle));
    const preferred = preferredId ? data.reviews.find(item => item.id === preferredId) : null;
    if (preferredId && !preferred) { clearPrivate(""); viewer.current = data.viewerContext; currentReviews.current = data.reviews; setWorkspace(data); return; }
    const currentChoice = changed ? null : reviewChoice.current;
    const person = preferred?.employee ?? reviewPeople(data).find(item => item.id === currentChoice?.employeePersonId) ?? data.reviews.find(row => row.audience !== "employee" && row.cycle === draft.cycle)?.employee ?? data.startablePeople[0] ?? data.reviews[0]?.employee;
    let cycle = preferred?.cycle ?? currentChoice?.cycle ?? draft.cycle;
    let row = person ? data.reviews.find(item => item.employee.id === person.id && item.cycle === cycle) : undefined;
    if (!row && person && !data.startablePeople.some(item => item.id === person.id)) { row = data.reviews.find(item => item.employee.id === person.id); cycle = row?.cycle ?? cycle; }
    reviewChoice.current = person ? { employeePersonId: person.id, cycle } : null;
    setStartDraft(current => ({ employeePersonId: person?.id ?? "", cycle, dueDate: currentChoice && !changed ? current.dueDate : draft.dueDate }));
    if (operationRef.current?.reviewId === null && currentChoice?.employeePersonId === person?.id) return;
    if (!row) { if (!operationRef.current) choose(null); return; }
    if (changed || selection.current?.id !== row.id || selection.current.audience !== row.audience) { choose(row); return; }
    if (recovery && recovery === conflict.current && recovery.generation === epoch.current && !operationRef.current && recovery.actorUserId === data.viewerContext.actorUserId && recovery.personId === data.viewerContext.personId && recovery.role === data.viewerContext.role && recovery.reviewId === row.id && recovery.employeePersonId === row.employee.id && recovery.audience === row.audience) {
      conflict.current = null; setRecoveryVisible(false);
      const editable = row.audience === "employee" ? !row.selfSubmittedAt && (recovery.command === "save_self" ? row.capabilities.saveSelf : recovery.command === "submit_self" && row.capabilities.submitSelf)
        : !row.finalisedAt && (recovery.command === "save_manager" ? row.capabilities.saveManager : recovery.command === "complete_manager" ? row.capabilities.completeManager : recovery.command === "save_meeting" ? row.capabilities.saveMeeting : recovery.command === "submit_review" && row.capabilities.submitReview);
      if (editable) { currentRevision.current = row.audience === "employee" ? row.selfRevision : row.audience === "manager" ? row.managerRevision : row.readRevision; setRevision(currentRevision.current); }
      return;
    }
    if (!operationRef.current && !conflict.current) setRecoveryVisible(false);
    if (!dirty.current && !operationRef.current && !conflict.current) choose(row);
  }, [clearPrivate, choose, previewPersonId]);
  function accept(row: PerformanceReview, notice: string, channel: PerformanceMutationInput["command"] | null = null) {
    const keepAssessment = channel === "save_meeting" && dirtyParts.current.assessment;
    const keepMeeting = (channel === "save_manager" || channel === "complete_manager") && dirtyParts.current.meeting;
    track(null);
    currentReviews.current = orderedReviews([row, ...currentReviews.current.filter(old => old.id !== row.id)]);
    setWorkspace(current => current ? { ...current, reviews: currentReviews.current } : null);
    choose(row);
    if (keepAssessment) { setAssessment(assessment); dirtyParts.current.assessment = true; dirty.current = true; }
    if (keepMeeting) { setMeeting(meeting); heldDraft.current = held; setHeld(held); dirtyParts.current.meeting = true; dirty.current = true; }
    if (keepAssessment) draft.current.assessment = assessment;
    if (keepMeeting) draft.current.meeting = meeting;
    reviewChoice.current = { employeePersonId: row.employee.id, cycle: row.cycle }; setStartDraft(current => ({ ...current, employeePersonId: row.employee.id, cycle: row.cycle })); setMessage(notice);
  }
  function acceptDraft(row: PerformanceReview, saved: NonNullable<PendingOperation["draft"]>) {
    track(null);
    currentReviews.current = orderedReviews([row, ...currentReviews.current.filter(old => old.id !== row.id)]);
    setWorkspace(current => current ? { ...current, reviews: currentReviews.current } : null);
    currentRevision.current = row.audience === "employee" ? row.selfRevision : row.audience === "manager" ? row.managerRevision : row.readRevision;
    setRevision(currentRevision.current);
    if (draftVersions.current[saved.channel] === saved.version) dirtyParts.current[saved.channel] = false;
    dirty.current = Object.values(dirtyParts.current).some(Boolean);
    setRecoveryVisible(false);
    setMessage(dirty.current ? "" : "Saved.");
  }
  function edited(channel: DraftChannel) {
    dirty.current = true; dirtyParts.current[channel] = true; draftVersions.current[channel] += 1;
  }
  function editSelf(index: number, value: string) {
    edited("self"); draft.current.answers = draft.current.answers.map((answer, i) => i === index ? value : answer); setAnswers(draft.current.answers);
  }
  function editAssessment(update: (current: PerformanceManagerInput) => PerformanceManagerInput) {
    if (!draft.current.assessment) return;
    edited("assessment"); draft.current.assessment = update(draft.current.assessment); setAssessment(draft.current.assessment);
  }
  function editMeeting(update: Partial<PerformanceMeeting>) {
    edited("meeting"); draft.current.meeting = { ...draft.current.meeting, ...update }; setMeeting(draft.current.meeting);
  }
  async function reconcile() {
    const pending = operationRef.current;
    if (readOnly || epoch.current !== generation || busyRef.current || !workspace || pending?.phase !== "uncertain") return;
    const ticket = generation, owner = claimBusy();
    try {
      const input = { operationId: pending.operationId, reviewId: pending.reviewId };
      const result = previewPersonId === undefined ? await reconcilePerformanceReviewOperation(input) : await reconcilePerformanceReviewOperation(input, previewPersonId);
      if (epoch.current !== ticket) return;
      if (!result.ok) { handleFailure(result); return; }
      if (result.data.status !== "committed") { setMessage("The update is still unconfirmed."); return; }
      const row = ownedRow(result.data.review, workspace.viewerContext);
      if (!row || (preview && row.audience !== "manager") || (pending.reviewId !== null && row.id !== pending.reviewId)) { unknown(); return; }
      if (pending.draft) acceptDraft(row, pending.draft);
      else accept(row, "Update confirmed.");
    } catch { if (epoch.current === ticket) unknown(); }
    finally { releaseBusy(owner); }
  }
  async function download() {
    if (epoch.current !== generation || busyRef.current || !selected?.capabilities.downloadDocument) return;
    const ticket = generation;
    const owner = claimBusy();
    try {
      const result = previewPersonId === undefined ? await getPerformanceReviewDocument(selected.id) : await getPerformanceReviewDocument(selected.id, previewPersonId);
      if (epoch.current !== ticket) return;
      if (!result.ok) { handleFailure(result); return; }
      if (result.document.audience !== selected.audience || result.document.employee.id !== selected.employee.id || result.document.code !== selected.code || result.document.cycle !== selected.cycle) { setMessage("The document could not be downloaded."); return; }
      const output = buildPerformanceReviewDownload(result.document);
      const url = URL.createObjectURL(new Blob([new Uint8Array(output.bytes)], { type: output.mimeType }));
      const timer = setTimeout(() => { URL.revokeObjectURL(url); urls.current.delete(url); }, 1000);
      urls.current.set(url, timer);
      const link = document.createElement("a"); link.href = url; link.download = output.fileName; link.click(); link.remove();
    } catch { if (epoch.current === ticket) setMessage("The document could not be downloaded."); }
    finally { releaseBusy(owner); }
  }
  async function start() {
    if (readOnly || epoch.current !== generation || busyRef.current || operationRef.current || !creating || !workspace || !["manager", "admin", "system_admin"].includes(workspace.viewerContext.role)) return;
    const ticket = generation;
    const parsed = new Date(startDraft.dueDate + "T00:00:00Z");
    if (!workspace.startablePeople.some(person => person.id === startDraft.employeePersonId) || !/^\d{4}$/.test(startDraft.cycle) || !/^\d{4}-\d{2}-\d{2}$/.test(startDraft.dueDate) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== startDraft.dueDate) { setMessage("Select an eligible employee, four-digit cycle and valid due date."); return; }
    const owner = claimBusy(), operationId = crypto.randomUUID();
    track({ operationId, reviewId: null, phase: "pending" });
    try {
      const input = { operationId, ...startDraft };
      const result = previewPersonId === undefined ? await startPerformanceReview(input) : await startPerformanceReview(input, previewPersonId);
      if (epoch.current !== ticket) return;
      if (!result.ok) { handleFailure(result, true); return; }
      if (result.committed !== true || result.operationId !== operationId || result.review.employee.id !== startDraft.employeePersonId || result.review.cycle !== startDraft.cycle) { unknown(); return; }
      const row = ownedRow(result.review, workspace.viewerContext);
      if (!row || (preview && row.audience !== "manager")) { unknown(); return; }
      accept(row, result.existing ? "Review opened." : "Review created.");
    } catch { if (epoch.current === ticket) unknown(); }
    finally { releaseBusy(owner); }
  }
  async function reload() {
    if (epoch.current !== generation || nativeActor.current === null) return;
    const ticket = advance();
    const recovery = conflict.current;
    setLoading(true); setMessage("");
    try {
      const result = await loadPerformanceReviews(previewPersonId);
      if (epoch.current !== ticket) return;
      if (!result.ok) { handleFailure(result); return; }
      applyLoaded(result.data, selectedId, recovery);
    } catch { if (epoch.current === ticket) { setMessage("Reviews could not be loaded."); setRecoveryVisible(true); } }
    finally { if (epoch.current === ticket) setLoading(false); }
  }
  function validMeeting(value: PerformanceMeeting) {
    try {
      return Number.isFinite(meetingEndMillis(value)) && Number.isInteger(value.duration) && value.duration >= 5 && value.duration <= 480 && value.notes.length <= 8000 && value.location.length <= 8000 && !!value.location.trim() && (value.mode !== "teams" || /^https:\/\/(teams\.microsoft\.com|teams\.live\.com)(?:[/:?#]|$)/.test(value.location));
    } catch { return false; }
  }
  function completeAssessment(assessment: PerformanceManagerInput | null) {
    return !!assessment && ![...assessment.answers, assessment.summary, assessment.managerNote].some(value => value.length > 8000) && !REQUIRED.some(index => !assessment.answers[index]?.trim()) && !RATED.some(index => !RATINGS.some(([value]) => value === assessment.ratings[index])) && !!assessment.summary.trim() && !!assessment.managerNote.trim() && RATINGS.some(([value]) => value === assessment.overallRating);
  }
  let meetingFinished = false;
  try { meetingFinished = validMeeting(meeting) && meetingEndMillis(meeting) <= clock; } catch {}
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let active = true;
    const update = () => {
      if (!active) return;
      setClock(Date.now());
      try {
        const remaining = meetingEndMillis(meeting) - Date.now();
        if (remaining > 0) timer = setTimeout(update, Math.min(remaining, 2147483647));
      } catch {}
    };
    update();
    return () => { active = false; clearTimeout(timer); };
  }, [meeting]);
  async function run(command: PerformanceMutationInput["command"], automatic = false) {
    if (!automatic && autoPromise.current && !await autoPromise.current) return;
    const selected = currentReviews.current.find(row => row.id === selection.current?.id);
    if (readOnly || epoch.current !== generation || busyRef.current || operationRef.current || !selected || !workspace) return;
    const ticket = generation;
    const answers = draft.current.answers, assessment = draft.current.assessment, meeting = draft.current.meeting, revision = currentRevision.current, held = heldDraft.current;
    const channel: DraftChannel = command === "save_self" ? "self" : command === "save_manager" ? "assessment" : "meeting";
    const saved = automatic ? { channel, version: draftVersions.current[channel] } : undefined;
    let mutation: PerformanceMutationInput;
    const operationId = crypto.randomUUID();
    if (command === "save_self" || command === "submit_self") {
      if (preview || selected.audience !== "employee" || selected.selfSubmittedAt || !(command === "save_self" ? selected.capabilities.saveSelf : selected.capabilities.submitSelf)) return;
      if (answers.some(answer => answer.length > 8000)) { setMessage("Use at most 8000 characters per answer."); return; }
      if (command === "submit_self" && REQUIRED.some(index => !answers[index]?.trim())) { setMessage("Complete the required answers."); return; }
      mutation = { operationId, reviewId: selected.id, expectedRevision: revision, command, input: { answers: [...answers] } };
    } else if (command === "save_manager" || command === "complete_manager") {
      if (selected.audience === "employee" || !assessment || selected.finalisedAt || !(command === "save_manager" ? selected.capabilities.saveManager : selected.capabilities.completeManager)) return;
      if ([...assessment.answers, assessment.summary, assessment.managerNote].some(value => value.length > 8000)) { setMessage("Use at most 8000 characters per answer."); return; }
      mutation = { operationId, reviewId: selected.id, expectedRevision: revision, command, input: { ...assessment, answers: [...assessment.answers], ratings: [...assessment.ratings] } };
    } else {
      if (selected.audience === "employee" || selected.finalisedAt || !(command === "save_meeting" ? selected.capabilities.saveMeeting : selected.capabilities.submitReview)) return;
      if (command === "submit_review" && dirtyParts.current.assessment && !selected.capabilities.saveManager) return;
      if (command === "submit_review" && (!held || !selected.managerCompletedAt || !completeAssessment(assessment))) { setMessage("Complete the assessment and confirm the meeting was held."); return; }
      if (command === "submit_review" && (!validMeeting(meeting) || meetingEndMillis(meeting) > Date.now())) { setMessage("The review meeting must finish before sending to HR."); return; }
      if (!validMeeting(meeting)) { setMessage("Check the meeting details."); return; }
      mutation = command === "save_meeting" ? { operationId, reviewId: selected.id, expectedRevision: revision, command, input: { ...meeting } } : { operationId, reviewId: selected.id, expectedRevision: revision, command, input: { ...meeting, held: true } };
    }
    const owner = claimBusy();
    if (automatic) setAutoSaving(true);
    const mutations: PerformanceMutationInput[] = command === "submit_review" && dirtyParts.current.assessment && assessment
      ? [{ operationId: crypto.randomUUID(), reviewId: selected.id, expectedRevision: revision, command: "save_manager", input: { ...assessment, answers: [...assessment.answers], ratings: [...assessment.ratings] } }, mutation]
      : [mutation];
    let expectedRevision = revision;
    try {
      for (const [index, item] of mutations.entries()) {
        const next = { ...item, expectedRevision };
        track({ operationId: next.operationId, reviewId: selected.id, phase: "pending", ...(saved ? { draft: saved } : {}) });
        const result = previewPersonId === undefined ? await mutatePerformanceReview(next) : await mutatePerformanceReview(next, previewPersonId);
        if (epoch.current !== ticket) return;
        if (!result.ok) {
          handleFailure(result, true);
          if (result.code === "conflict" && !result.uncertain) conflict.current = { generation: ticket, actorUserId: workspace.viewerContext.actorUserId, personId: workspace.viewerContext.personId, role: workspace.viewerContext.role, reviewId: selected.id, employeePersonId: selected.employee.id, audience: selected.audience, command: next.command };
          return;
        }
        if (result.committed !== true || result.operationId !== next.operationId || result.review.id !== selected.id || result.review.audience !== selected.audience) { unknown(); return; }
        const row = ownedRow(result.review, workspace.viewerContext);
        if (!row) { unknown(); return; }
        if (index === mutations.length - 1) {
          if (saved) acceptDraft(row, saved);
          else accept(row, (command.startsWith("save_") || command === "complete_manager") ? "Saved." : "Submitted.", command);
        } else {
          if (row.audience === "employee") { unknown(); return; }
          expectedRevision = row.audience === "manager" ? row.managerRevision : row.readRevision;
          currentRevision.current = expectedRevision;
          setRevision(expectedRevision);
          dirtyParts.current.assessment = false;
          dirty.current = dirtyParts.current.meeting;
          currentReviews.current = orderedReviews([row, ...currentReviews.current.filter(old => old.id !== row.id)]);
          setWorkspace(current => current ? { ...current, reviews: currentReviews.current } : null);
        }
      }
      return true;
    } catch { if (epoch.current === ticket) unknown(); }
    finally { if (automatic && epoch.current === ticket) setAutoSaving(false); releaseBusy(owner); }
  }
  async function flushDrafts(): Promise<boolean> {
    if (autoPromise.current) return autoPromise.current;
    if (!dirty.current) return true;
    if (readOnly || recoveryVisible || conflict.current || operationRef.current || busyRef.current) return false;
    const ticket = epoch.current;
    const saving = (async () => {
      while (dirty.current && epoch.current === ticket) {
        const command = dirtyParts.current.self ? "save_self" : dirtyParts.current.assessment ? "save_manager" : "save_meeting";
        if (command === "save_meeting" && (!selected || selected.audience === "employee" || !selected.managerCompletedAt || !validMeeting(draft.current.meeting))) return false;
        if (await run(command, true) !== true) return false;
      }
      return epoch.current === ticket && !dirty.current;
    })();
    autoPromise.current = saving;
    try { return await saving; }
    finally { if (autoPromise.current === saving) autoPromise.current = null; }
  }
  useEffect(() => { flush.current = flushDrafts; });
  useEffect(() => {
    if (!dirty.current || readOnly || busy || operation || recoveryVisible || conflict.current) return;
    const timer = setTimeout(() => { void flush.current(); }, 600);
    return () => clearTimeout(timer);
  }, [answers, assessment, meeting, generation, revision, readOnly, busy, operation, recoveryVisible]);
  useEffect(() => {
    const onUnload = (event: BeforeUnloadEvent) => { if (dirty.current || operationRef.current) { event.preventDefault(); event.returnValue = ""; } };
    const onHidden = () => { if (document.visibilityState === "hidden") void flush.current(); };
    window.addEventListener("beforeunload", onUnload);
    document.addEventListener("visibilitychange", onHidden);
    return () => { window.removeEventListener("beforeunload", onUnload); document.removeEventListener("visibilitychange", onHidden); };
  }, []);
  useEffect(() => {
    let active = true;
    const downloads = urls.current;
    let unsubscribe = () => {};
    try {
      const { data: { subscription } } = createClient().auth.onAuthStateChange((event: AuthChangeEvent, session: Session | null) => {
        if (!active) return;
        const id = session?.user.id ?? null;
        if (event === "SIGNED_OUT" || id === null) { nativeActor.current = null; clearPrivate("Your session has ended."); return; }
        const previous = nativeActor.current;
        nativeActor.current = id;
        if (event === "INITIAL_SESSION" && (previous === undefined || previous === id)) return;
        if (previous !== id || event === "SIGNED_IN") clearPrivate("");
        const ticket = advance();
        setLoading(true); setMessage("");
        void Promise.resolve().then(async () => {
          if (!active || epoch.current !== ticket) return;
          try {
            const result = await loadPerformanceReviews(previewPersonId);
            if (!active || epoch.current !== ticket) return;
            if (!result.ok) { handleFailure(result); return; }
            applyLoaded(result.data, selection.current?.id ?? null);
          } catch { if (active && epoch.current === ticket) { setMessage("Reviews could not be loaded."); setRecoveryVisible(true); } }
          finally { if (active && epoch.current === ticket) setLoading(false); }
        });
      });
      unsubscribe = () => subscription.unsubscribe();
    } catch { void Promise.resolve().then(() => { if (active) clearPrivate("Reviews could not be loaded."); }); return; }
    const ticket = epoch.current;
    void Promise.resolve().then(() => {
      if (!active || epoch.current !== ticket) return null;
      setLoading(true);
      return loadPerformanceReviews(previewPersonId);
    }).then(result => {
      if (!result || !active || epoch.current !== ticket) return;
      setGeneration(ticket);
      if (!result.ok) { handleFailure(result); return; }
      applyLoaded(result.data, null);
    }).catch(() => { if (active && epoch.current === ticket) { setGeneration(ticket); setMessage("Reviews could not be loaded."); setRecoveryVisible(true); } }).finally(() => { if (active && epoch.current === ticket) setLoading(false); });
    return () => {
      active = false; retire(); unsubscribe(); busyOwner.current = null; busyRef.current = false; operationRef.current = null;
      for (const [url, timer] of downloads) { clearTimeout(timer); URL.revokeObjectURL(url); } downloads.clear();
    };
  }, [advance, applyLoaded, clearPrivate, handleFailure, retire, previewPersonId]);
  useEffect(() => {
    if (!invitationScope || invitationSent || !invitationRequested || !selectedId || epoch.current !== generation) return;
    const ticket = generation, reviewId = selectedId;
    let active = true, inFlight = false, confirmed = false, attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (!active || inFlight || confirmed || epoch.current !== ticket) return;
      clearTimeout(timer);
      inFlight = true;
      attempts += 1;
      try {
        const result = await loadPerformanceReviewMeetingInvitationStatus(reviewId, previewPersonId);
        if (!active || epoch.current !== ticket) return;
        if (result.ok === true && result.reviewId === reviewId && result.sent === true) {
          confirmed = true;
          setConfirmedInvitation(invitationScope);
        }
      } catch {} finally {
        inFlight = false;
        if (active && !confirmed && epoch.current === ticket) timer = setTimeout(refresh, INVITATION_STATUS_DELAYS[attempts - 1] ?? 60_000);
      }
    };
    const onFocus = () => { if (!inFlight) { attempts = 0; void refresh(); } };
    if (typeof window !== "undefined") window.addEventListener("focus", onFocus);
    void refresh();
    return () => { active = false; clearTimeout(timer); if (typeof window !== "undefined") window.removeEventListener("focus", onFocus); };
  }, [generation, invitationRequested, invitationScope, invitationSent, previewPersonId, selectedId]);
  const blocked = readOnly || (busy && !autoSaving) || (operation !== null && (!autoSaving || operation.phase === "uncertain"));
  const editingBlocked = blocked;
  const selfDisabled = preview || editingBlocked || selected?.audience !== "employee" || !selected.capabilities.saveSelf || Boolean(selected.selfSubmittedAt);
  const managerDisabled = editingBlocked || !selected || selected.audience === "employee" || !selected.capabilities.saveManager || Boolean(selected.finalisedAt);
  const meetingDisabled = editingBlocked || !selected || selected.audience === "employee" || !selected.capabilities.saveMeeting || Boolean(selected.finalisedAt);
  const heldDisabled = blocked || !selected || selected.audience === "employee" || !selected.capabilities.submitReview || Boolean(selected.finalisedAt);
  const managerActions = selected?.audience === "manager" || selected?.audience === "admin" && (selected.capabilities.saveManager || selected.capabilities.completeManager || selected.capabilities.saveMeeting || selected.capabilities.submitReview);
  return <section className={styles.workspace} aria-label="Performance reviews" aria-busy={busy || loading}>
    <header className={styles.toolbar}><h1>Performance reviews</h1></header>
    {autoSaving ? <p role="status">Saving…</p> : null}
    {message ? <p role={["Saved.", "Submitted.", "Review opened.", "Review created.", "Update confirmed."].includes(message) ? "status" : "alert"}>{message}</p> : null}
    {recoveryVisible ? <button type="button" className={styles.recovery} onClick={() => reload()} disabled={busy}>Reload</button> : null}
    {loading ? <p role="status">Loading performance reviews…</p> : !message && people.length === 0 && workspace ? <p role="status">No performance reviews yet.</p> : null}
    {operation?.phase === "uncertain" ? <button type="button" disabled={busy} onClick={() => reconcile()}>Reconcile update</button> : null}
    {workspace && people.length > 0 ? <div className={styles.startLayout}>
      <aside className={styles.employeeSidebar}>
        <div className={styles.searchTools}><label className={`${toolbar.search} ${styles.searchField}`}><Search size={17} aria-hidden="true" /><input aria-label="Search employees" type="search" placeholder="Search your team" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
      <nav className={styles.employeeList} aria-label="Review employees">{filteredPeople.map(person => <button type="button" key={person.id} aria-label={`${person.name} — ${person.company}`} aria-pressed={person.id === startDraft.employeePersonId} disabled={operation !== null && !autoSaving} onClick={async () => {
        if (epoch.current !== generation || ((busyRef.current || operationRef.current) && !autoPromise.current)) return;
        const ticket = generation;
        if (dirty.current && !await flush.current()) return;
        if (epoch.current !== ticket || busyRef.current || operationRef.current) return;
        const draft = newReviewDraft(), selectedCycle = startDraft.cycle || draft.cycle;
        const row = currentReviews.current.find(item => item.employee.id === person.id && item.cycle === selectedCycle) ?? (!workspace.startablePeople.some(item => item.id === person.id) ? currentReviews.current.find(item => item.employee.id === person.id) : undefined);
        const cycle = row?.cycle ?? selectedCycle;
        reviewChoice.current = { employeePersonId: person.id, cycle };
        choose(row ?? null); setStartYear(Number(draft.cycle)); setStartDraft(current => ({ employeePersonId: person.id, cycle, dueDate: current.dueDate || draft.dueDate }));
      }}>
        <span className={styles.avatar} aria-hidden="true">{person.name.split(/\s+/).filter(Boolean).map(part => part[0]).slice(0, 2).join("")}</span>
        <span className={styles.employeeDetails}><strong>{person.name}</strong><span>{person.jobTitle} · {person.team}</span></span>
        <span className={styles.company}>{person.company}</span>
      </button>)}</nav>
      {filteredPeople.length === 0 ? <p className={styles.listState} role="status">No employees match that search.</p> : null}
      </aside>
      <div className={styles.reviewPanel}>
        {startPerson ? <header><h2>{startPerson.name} — {startPerson.company}</h2><p>{startPerson.jobTitle} · {startPerson.team}</p></header> : null}
        {startPerson ? <label className={styles.cycle}>Cycle<select name="start-cycle" disabled={(busy || operation !== null) && !autoSaving} value={startDraft.cycle} onChange={async event => {
          const cycle = event.target.value;
          if (epoch.current !== generation || ((busyRef.current || operationRef.current) && !autoPromise.current)) return;
          const ticket = generation;
          if (dirty.current && !await flush.current()) return;
          if (epoch.current !== ticket || busyRef.current || operationRef.current) return;
          reviewChoice.current = { employeePersonId: startPerson.id, cycle };
          choose(currentReviews.current.find(row => row.employee.id === startPerson.id && row.cycle === cycle) ?? null);
          setStartDraft(current => ({ ...current, cycle }));
        }}>{cycles.map(year => <option key={year} value={year}>{year}</option>)}</select></label> : null}
        {creating ? <form className={styles.startForm} aria-label="New yearly review" onSubmit={event => { event.preventDefault(); void start(); }}>
          <label>Due date<input name="start-dueDate" type="date" disabled={blocked} value={startDraft.dueDate} onChange={event => { if (epoch.current === generation && !blocked) setStartDraft(current => ({ ...current, dueDate: event.target.value })); }} /></label>
          <div className={styles.startActions}><button type="submit" className={styles.primaryButton} disabled={blocked || !startPerson}>Start review</button></div>
        </form> : null}
      {selected ? <article className={styles.card}>
        {selected.capabilities.downloadDocument ? <button type="button" disabled={busy} onClick={() => download()}>Download Word</button> : null}
        <p>{selected.cycle} · {selected.dueDate} · {selected.selfStatus === "awaiting_employee" ? "Awaiting employee" : "Manager review"}</p>
        {selected.audience === "employee" ? <form aria-label="Self assessment" onBlur={() => flush.current()} onSubmit={event => { event.preventDefault(); void run("submit_self"); }}><h2>Self assessment</h2>
          {QUESTIONS[selected.employee.company].map((prompt: string, index: number) => <label key={prompt}>{prompt}<textarea name={`self-${index}`} maxLength={8000} value={answers[index] ?? ""} disabled={selfDisabled} onChange={event => { if (!selfDisabled && epoch.current === generation) { editSelf(index, event.target.value); } }} /></label>)}
          {selected.audience === "employee" ? <div className={styles.toolbar}><button type="button" disabled={selfDisabled} onClick={() => run("save_self")}>Save self draft</button><button type="submit" className={selected.selfSubmittedAt ? styles.submittedButton : undefined} disabled={blocked || !selected.capabilities.submitSelf || Boolean(selected.selfSubmittedAt)}>{selected.selfSubmittedAt ? "Self assessment submitted" : "Submit self assessment"}</button></div> : null}
        </form> : null}
        {selected.audience !== "employee" && assessment ? <form aria-label="Manager assessment" onBlur={() => flush.current()} onSubmit={event => { event.preventDefault(); void run(invitationStarted ? "save_manager" : "complete_manager"); }}><h2>Manager assessment</h2>
          {QUESTIONS[selected.employee.company].map((prompt: string, index: number) => <div className={styles.question} key={prompt}>
            <label>{prompt}<span className={styles.answerLabel}>Employee answer</span><textarea name={`self-${index}`} value={answers[index] ?? ""} disabled /></label>
            <label>Manager answer<textarea aria-label={`${prompt} — Manager answer`} name={`manager-${index}`} maxLength={8000} value={assessment.answers[index] ?? ""} disabled={managerDisabled} onChange={event => { if (!managerDisabled && epoch.current === generation) { editAssessment(current => ({ ...current, answers: current.answers.map((value, i) => i === index ? event.target.value : value) })); } }} /></label>
            {RATED.includes(index) ? <label>Manager rating<select name={`rating-${index}`} disabled={managerDisabled} value={assessment.ratings[index] ?? ""} onChange={event => { if (!managerDisabled && epoch.current === generation) { editAssessment(current => ({ ...current, ratings: current.ratings.map((value, i) => i === index ? event.target.value : value) })); } }}><option value="">Select rating</option>{RATINGS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label> : null}
          </div>)}
          <label>Overall manager assessment<textarea name="summary" maxLength={8000} value={assessment.summary} disabled={managerDisabled} onChange={event => { if (!managerDisabled && epoch.current === generation) { editAssessment(current => ({ ...current, summary: event.target.value })); } }} /></label>
          <label>Overall rating<select name="overallRating" value={assessment.overallRating} disabled={managerDisabled} onChange={event => { if (!managerDisabled && epoch.current === generation) { editAssessment(current => ({ ...current, overallRating: event.target.value })); } }}><option value="">Select rating</option>{RATINGS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>Private manager note<textarea name="managerNote" maxLength={8000} value={assessment.managerNote} disabled={managerDisabled} onChange={event => { if (!managerDisabled && epoch.current === generation) { editAssessment(current => ({ ...current, managerNote: event.target.value })); } }} /></label>
          {managerActions ? <div className={styles.toolbar}><button type="button" className={invitationStarted ? styles.draftButton : styles.primaryButton} onClick={() => run(invitationStarted ? "save_manager" : "complete_manager")} disabled={blocked || !(invitationStarted ? selected.capabilities.saveManager : selected.capabilities.completeManager) || Boolean(selected.finalisedAt)}>{invitationStarted ? "Save draft" : "Save draft and invite meeting"}</button>{invitationSent ? <span className={styles.invitationHint}>Reply with Meeting in Outlook to schedule the review. Include ai@mobilityaccess.com.au and the employee, and keep the review code.</span> : null}</div> : null}
        </form> : null}
        {selected.audience !== "employee" ? <form aria-label="Review meeting" onBlur={() => flush.current()} onSubmit={event => { event.preventDefault(); void run("submit_review"); }}><h2>Review meeting</h2>
          <label>Date<input type="date" name="meeting-date" value={meeting.date} disabled={meetingDisabled} onChange={event => { if (!meetingDisabled && epoch.current === generation) { editMeeting({ date: event.target.value }); } }} /></label>
          <label>Time (Melbourne)<input type="time" name="meeting-time" value={meeting.time} disabled={meetingDisabled} onChange={event => { if (!meetingDisabled && epoch.current === generation) { editMeeting({ time: event.target.value }); } }} /></label>
          <label>Duration (minutes)<input type="number" min={5} max={480} name="meeting-duration" value={meeting.duration} disabled={meetingDisabled} onChange={event => { if (!meetingDisabled && epoch.current === generation) { editMeeting({ duration: Number(event.target.value) }); } }} /></label>
          <label>Mode<select name="meeting-mode" value={meeting.mode} disabled={meetingDisabled} onChange={event => { if (!meetingDisabled && epoch.current === generation) { editMeeting({ mode: event.target.value as PerformanceMeeting["mode"] }); } }}><option value="in_person">In person</option><option value="teams">Teams</option><option value="phone">Phone</option></select></label>
          <label>Location<input name="meeting-location" maxLength={8000} value={meeting.location} disabled={meetingDisabled} onChange={event => { if (!meetingDisabled && epoch.current === generation) { editMeeting({ location: event.target.value }); } }} /></label>
          <label>Meeting notes<textarea name="meeting-notes" maxLength={8000} value={meeting.notes} disabled={meetingDisabled} onChange={event => { if (!meetingDisabled && epoch.current === generation) { editMeeting({ notes: event.target.value }); } }} /></label>
          {managerActions ? <><label className={styles.meetingHeld}><input type="checkbox" name="held" checked={held} disabled={heldDisabled} onChange={event => { if (epoch.current === generation && !heldDisabled) { heldDraft.current = event.target.checked; setHeld(event.target.checked); } }} />Meeting was held</label><div className={styles.toolbar}><button type="submit" disabled={blocked || !held || !meetingFinished || !completeAssessment(assessment) || !selected.managerCompletedAt || !selected.capabilities.submitReview || Boolean(selected.finalisedAt)}>Save and send to HR</button></div></> : null}
          {selected.managerCompletedAt ? <p>Assessment saved: {selected.managerCompletedAt}</p> : null}{selected.finalisedAt ? <p>Finalised: {selected.finalisedAt}</p> : null}
        </form> : null}
      </article> : null}
      </div>
    </div> : null}
  </section>;
}
