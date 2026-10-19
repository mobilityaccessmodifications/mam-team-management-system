"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { loadPerformanceReviews, mutatePerformanceReview, startPerformanceReview, getPerformanceReviewDocument, reconcilePerformanceReviewOperation } from "@/app/performance-reviews/actions";
import { buildPerformanceReviewDownload } from "@/lib/performance-review-document";
import { createClient } from "@/lib/supabase/client";
import { QUESTIONS } from "@/lib/performance-review-questions.mjs";
import type { PerformanceFailure, PerformanceReview, PerformanceSelfReview, PerformanceManagerInput, PerformanceMeeting, PerformanceMutationInput, PerformanceWorkspace } from "@/lib/performance-review-types";
import styles from "./performance-review-workspace.module.css";

const REQUIRED = [0, 3, 4, 5, 6, 7, 8, 9, 10];
const RATED = [0, 1, 2, 6, 7, 8, 9];
const RATINGS = [["1 Needs improvement", "1 Needs improvement"], ["2 Meets expectations", "2 Meets expectations"], ["3 Exceeds expectations", "3 Exceeds expectations"], ["N Not enough evidence", "N Not enough evidence"]];
type PendingOperation = { operationId: string; reviewId: string | null; phase: "pending" | "uncertain" };
type ConflictScope = { generation: number; actorUserId: string; personId: string | null; role: PerformanceWorkspace["viewerContext"]["role"]; reviewId: string; employeePersonId: string; audience: PerformanceReview["audience"]; command: PerformanceMutationInput["command"] };
const EMPTY_MEETING: PerformanceMeeting = { date: "", time: "", duration: 30, mode: "in_person", location: "", notes: "" };

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
  if (row.audience === "employee") return ["employee", "account", "manager"].includes(viewer.role) && row.employee.id === viewer.personId ? selfRow(row) : null;
  if (row.audience === "manager" && (viewer.role !== "manager" || row.manager.id !== viewer.personId || row.employee.id === viewer.personId)) return null;
  if (row.audience === "admin" && viewer.role !== "admin" && viewer.role !== "system_admin") return null;
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
  return { viewerContext: { ...data.viewerContext }, reviews: orderedReviews(data.reviews.map(row => ownedRow(row, data.viewerContext)).filter((row): row is PerformanceReview => row !== null)), startablePeople: data.viewerContext.role === "manager" ? data.startablePeople.map(person => ({ ...person })) : [] };
}

function managerInput(row: PerformanceReview): PerformanceManagerInput | null {
  return row.audience === "employee" ? null : { answers: [...row.managerAnswers], ratings: [...row.ratings], summary: row.summary, overallRating: row.overallRating, managerNote: row.managerNote };
}

export default function PerformanceReviewWorkspace({ previewPersonId }: { previewPersonId?: string } = {}) {
  const readOnly = previewPersonId !== undefined;
  const [workspace, setWorkspace] = useState<PerformanceWorkspace | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [answers, setAnswers] = useState<string[]>([]);
  const [assessment, setAssessment] = useState<PerformanceManagerInput | null>(null);
  const [meeting, setMeeting] = useState<PerformanceMeeting>({ ...EMPTY_MEETING });
  const [held, setHeld] = useState(false);
  const [creating, setCreating] = useState(false);
  const [startDraft, setStartDraft] = useState({ employeePersonId: "", cycle: "", dueDate: "" });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [generation, setGeneration] = useState(0);
  const [revision, setRevision] = useState("");
  const epoch = useRef(0);
  const dirty = useRef(false);
  const dirtyParts = useRef({ assessment: false, meeting: false });
  const [assessmentDirty, setAssessmentDirty] = useState(false);
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
  const track = useCallback((next: PendingOperation | null) => { if (next) conflict.current = null; operationRef.current = next; setOperation(next); }, []);
  const advance = useCallback(() => {
    if (operationRef.current?.phase === "pending") track({ ...operationRef.current, phase: "uncertain" });
    busyOwner.current = null; busyRef.current = false; setBusy(false); setLoading(false);
    const next = ++epoch.current;
    if (conflict.current) conflict.current = conflict.current.generation === next - 1 ? { ...conflict.current, generation: next } : null;
    setGeneration(next); return next;
  }, [track]);
  function claimBusy() { const owner = Symbol(); busyOwner.current = owner; busyRef.current = true; setBusy(true); setMessage(""); return owner; }
  function releaseBusy(owner: symbol) { if (busyOwner.current === owner) { busyOwner.current = null; busyRef.current = false; setBusy(false); } }
  const unknown = useCallback(() => { if (operationRef.current) track({ ...operationRef.current, phase: "uncertain" }); setMessage("The update could not be confirmed. Reconcile before submitting again."); }, [track]);
  const choose = useCallback((row: PerformanceReview | null) => {
    advance(); conflict.current = null; dirty.current = false; dirtyParts.current = { assessment: false, meeting: false }; setAssessmentDirty(false);
    selection.current = row ? { id: row.id, audience: row.audience } : null;
    setRevision(row ? row.audience === "employee" ? row.selfRevision : row.audience === "manager" ? row.managerRevision : row.readRevision : "");
    setSelectedId(row?.id ?? null); setAnswers(row ? [...row.selfAnswers] : []);
    setAssessment(row ? managerInput(row) : null);
    setMeeting(!row || row.audience === "employee" ? { ...EMPTY_MEETING } : { ...(row.meeting ?? EMPTY_MEETING) });
    setHeld(false); setMessage("");
  }, [advance]);
  const clearPrivate = useCallback((notice: string) => {
    track(null); choose(null); viewer.current = null;
    setWorkspace(null); setCreating(false); setStartDraft({ employeePersonId: "", cycle: "", dueDate: "" });
    for (const [url, timer] of urls.current) { clearTimeout(timer); URL.revokeObjectURL(url); }
    urls.current.clear(); setMessage(notice);
  }, [track, choose]);
  const handleFailure = useCallback((result: PerformanceFailure, writing = false) => {
    if (result.code === "unauthenticated" || result.code === "forbidden") { clearPrivate(result.message); return; }
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
    viewer.current = data.viewerContext; setWorkspace(data);
    const row = preferredId ? data.reviews.find(item => item.id === preferredId) : data.reviews[0];
    if (!row) {
      if (preferredId !== null) { clearPrivate(""); viewer.current = data.viewerContext; setWorkspace(data); }
      else choose(null);
      return;
    }
    if (changed || selection.current?.id !== row.id || selection.current.audience !== row.audience) { choose(row); return; }
    if (recovery && recovery === conflict.current && recovery.generation === epoch.current && !operationRef.current && recovery.actorUserId === data.viewerContext.actorUserId && recovery.personId === data.viewerContext.personId && recovery.role === data.viewerContext.role && recovery.reviewId === row.id && recovery.employeePersonId === row.employee.id && recovery.audience === row.audience) {
      conflict.current = null;
      const editable = row.audience === "employee" ? !row.selfSubmittedAt && (recovery.command === "save_self" ? row.capabilities.saveSelf : recovery.command === "submit_self" && row.capabilities.submitSelf)
        : row.audience === "manager" && !row.finalisedAt && (recovery.command === "save_manager" ? row.capabilities.saveManager : recovery.command === "complete_manager" ? row.capabilities.completeManager : recovery.command === "save_meeting" ? row.capabilities.saveMeeting : recovery.command === "submit_review" && row.capabilities.submitReview);
      if (editable) setRevision(row.audience === "employee" ? row.selfRevision : row.audience === "manager" ? row.managerRevision : row.readRevision);
      return;
    }
    if (!dirty.current && !operationRef.current && !conflict.current) choose(row);
  }, [clearPrivate, choose, previewPersonId]);
  function accept(row: PerformanceReview, notice: string, channel: PerformanceMutationInput["command"] | null = null) {
    const keepAssessment = channel === "save_meeting" && dirtyParts.current.assessment;
    const keepMeeting = (channel === "save_manager" || channel === "complete_manager") && dirtyParts.current.meeting;
    track(null);
    setWorkspace(current => current ? { ...current, reviews: orderedReviews([row, ...current.reviews.filter(old => old.id !== row.id)]) } : null);
    choose(row);
    if (keepAssessment) { setAssessment(assessment); setAssessmentDirty(true); dirtyParts.current.assessment = true; dirty.current = true; }
    if (keepMeeting) { setMeeting(meeting); setHeld(held); dirtyParts.current.meeting = true; dirty.current = true; }
    setCreating(false); setStartDraft({ employeePersonId: "", cycle: "", dueDate: "" }); setMessage(notice);
  }
  async function reconcile() {
    const pending = operationRef.current;
    if (readOnly || epoch.current !== generation || busyRef.current || !workspace || pending?.phase !== "uncertain") return;
    const ticket = generation, owner = claimBusy();
    try {
      const result = await reconcilePerformanceReviewOperation({ operationId: pending.operationId, reviewId: pending.reviewId });
      if (epoch.current !== ticket) return;
      if (!result.ok) { handleFailure(result); return; }
      if (result.data.status !== "committed") { setMessage("The update is still unconfirmed."); return; }
      const row = ownedRow(result.data.review, workspace.viewerContext);
      if (!row || (pending.reviewId !== null && row.id !== pending.reviewId)) { unknown(); return; }
      accept(row, "Update confirmed.");
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
    if (readOnly || epoch.current !== generation || busyRef.current || operationRef.current || !creating || !workspace || workspace.viewerContext.role !== "manager") return;
    const ticket = generation;
    const parsed = new Date(startDraft.dueDate + "T00:00:00Z");
    if (!workspace.startablePeople.some(person => person.id === startDraft.employeePersonId) || !/^\d{4}$/.test(startDraft.cycle) || !/^\d{4}-\d{2}-\d{2}$/.test(startDraft.dueDate) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== startDraft.dueDate) { setMessage("Select an eligible employee, four-digit cycle and valid due date."); return; }
    const owner = claimBusy(), operationId = crypto.randomUUID();
    track({ operationId, reviewId: null, phase: "pending" });
    try {
      const result = await startPerformanceReview({ operationId, ...startDraft });
      if (epoch.current !== ticket) return;
      if (!result.ok) { handleFailure(result, true); return; }
      if (result.committed !== true || result.operationId !== operationId || result.review.employee.id !== startDraft.employeePersonId || result.review.cycle !== startDraft.cycle) { unknown(); return; }
      const row = ownedRow(result.review, workspace.viewerContext);
      if (!row) { unknown(); return; }
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
    } catch { if (epoch.current === ticket) setMessage("Reviews could not be loaded."); }
    finally { if (epoch.current === ticket) setLoading(false); }
  }
  async function run(command: PerformanceMutationInput["command"]) {
    if (readOnly || epoch.current !== generation || busyRef.current || operationRef.current || !selected || !workspace) return;
    const ticket = generation;
    let mutation: PerformanceMutationInput;
    const operationId = crypto.randomUUID();
    if (command === "save_self" || command === "submit_self") {
      if (selected.audience !== "employee" || selected.selfSubmittedAt || !(command === "save_self" ? selected.capabilities.saveSelf : selected.capabilities.submitSelf)) return;
      if (answers.some(answer => answer.length > 8000)) { setMessage("Use at most 8000 characters per answer."); return; }
      if (command === "submit_self" && REQUIRED.some(index => !answers[index]?.trim())) { setMessage("Complete the required answers."); return; }
      mutation = { operationId, reviewId: selected.id, expectedRevision: revision, command, input: { answers: [...answers] } };
    } else if (command === "save_manager" || command === "complete_manager") {
      if (selected.audience !== "manager" || !assessment || selected.finalisedAt || !(command === "save_manager" ? selected.capabilities.saveManager : selected.capabilities.completeManager)) return;
      if ([...assessment.answers, assessment.summary, assessment.managerNote].some(value => value.length > 8000)) { setMessage("Use at most 8000 characters per answer."); return; }
      if (command === "complete_manager" && (REQUIRED.some(index => !assessment.answers[index]?.trim()) || RATED.some(index => !RATINGS.some(([value]) => value === assessment.ratings[index])) || !assessment.summary.trim() || !assessment.managerNote.trim() || !RATINGS.some(([value]) => value === assessment.overallRating))) { setMessage("Complete the required manager answers, ratings and notes."); return; }
      mutation = { operationId, reviewId: selected.id, expectedRevision: revision, command, input: { ...assessment, answers: [...assessment.answers], ratings: [...assessment.ratings] } };
    } else {
      if (selected.audience !== "manager" || selected.finalisedAt || !(command === "save_meeting" ? selected.capabilities.saveMeeting : selected.capabilities.submitReview)) return;
      if (command === "submit_review" && (!held || !selected.managerCompletedAt || dirtyParts.current.assessment)) { setMessage("Complete the assessment and confirm the meeting was held."); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(meeting.date) || !/^\d{2}:\d{2}$/.test(meeting.time) || !Number.isInteger(meeting.duration) || meeting.duration < 5 || meeting.duration > 480 || meeting.notes.length > 8000 || meeting.location.length > 8000) { setMessage("Check the meeting details."); return; }
      mutation = command === "save_meeting" ? { operationId, reviewId: selected.id, expectedRevision: revision, command, input: { ...meeting } } : { operationId, reviewId: selected.id, expectedRevision: revision, command, input: { ...meeting, held: true } };
    }
    const owner = claimBusy();
    track({ operationId, reviewId: selected.id, phase: "pending" });
    try {
      const result = await mutatePerformanceReview(mutation);
      if (epoch.current !== ticket) return;
      if (!result.ok) {
        handleFailure(result, true);
        if (result.code === "conflict" && !result.uncertain) conflict.current = { generation: ticket, actorUserId: workspace.viewerContext.actorUserId, personId: workspace.viewerContext.personId, role: workspace.viewerContext.role, reviewId: selected.id, employeePersonId: selected.employee.id, audience: selected.audience, command };
        return;
      }
      if (result.committed !== true || result.operationId !== operationId || result.review.id !== selected.id || result.review.audience !== selected.audience) { unknown(); return; }
      const row = ownedRow(result.review, workspace.viewerContext);
      if (!row) { unknown(); return; }
      accept(row, command.startsWith("save_") ? "Saved." : "Submitted.", command);
    } catch { if (epoch.current === ticket) unknown(); }
    finally { releaseBusy(owner); }
  }
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
          } catch { if (active && epoch.current === ticket) setMessage("Reviews could not be loaded."); }
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
    }).catch(() => { if (active && epoch.current === ticket) { setGeneration(ticket); setMessage("Reviews could not be loaded."); } }).finally(() => { if (active && epoch.current === ticket) setLoading(false); });
    return () => {
      active = false; retire(); unsubscribe(); busyOwner.current = null; busyRef.current = false; operationRef.current = null;
      for (const [url, timer] of downloads) { clearTimeout(timer); URL.revokeObjectURL(url); } downloads.clear();
    };
  }, [advance, applyLoaded, clearPrivate, handleFailure, retire, previewPersonId]);
  const blocked = readOnly || busy || operation !== null;
  const selfDisabled = blocked || selected?.audience !== "employee" || !selected.capabilities.saveSelf || Boolean(selected.selfSubmittedAt);
  const managerDisabled = blocked || selected?.audience !== "manager" || !selected.capabilities.saveManager || Boolean(selected.finalisedAt);
  const meetingDisabled = blocked || selected?.audience !== "manager" || !selected.capabilities.saveMeeting || Boolean(selected.finalisedAt);
  return <section className={styles.workspace} aria-label="Performance reviews" aria-busy={busy || loading}>
    <header className={styles.toolbar}><h1>Performance reviews</h1><button type="button" onClick={() => reload()} disabled={busy}>Reload</button>{workspace?.startablePeople.length ? <button type="button" disabled={blocked} onClick={() => { if (epoch.current === generation && !blocked) setCreating(true); }}>New yearly review</button> : null}</header>
    {message ? <p role={["Saved.", "Submitted.", "Review opened.", "Review created.", "Update confirmed."].includes(message) ? "status" : "alert"}>{message}</p> : null}
    {loading ? <p role="status">Loading performance reviews…</p> : !message && workspace?.reviews.length === 0 ? <p role="status">No performance reviews yet.</p> : null}
    {operation?.phase === "uncertain" ? <button type="button" disabled={busy} onClick={() => reconcile()}>Reconcile update</button> : null}
    {creating ? <form aria-label="New yearly review" onSubmit={event => { event.preventDefault(); void start(); }}>
      <label>Employee<select name="start-person" disabled={blocked} value={startDraft.employeePersonId} onChange={event => { if (epoch.current === generation && !blocked) setStartDraft(current => ({ ...current, employeePersonId: event.target.value })); }}><option value="">Select employee</option>{workspace?.startablePeople.map(person => <option key={person.id} value={person.id}>{person.name} — {person.company}</option>)}</select></label>
      <label>Cycle<input name="start-cycle" maxLength={4} inputMode="numeric" disabled={blocked} value={startDraft.cycle} onChange={event => { if (epoch.current === generation && !blocked) setStartDraft(current => ({ ...current, cycle: event.target.value })); }} /></label>
      <label>Due date<input name="start-dueDate" type="date" disabled={blocked} value={startDraft.dueDate} onChange={event => { if (epoch.current === generation && !blocked) setStartDraft(current => ({ ...current, dueDate: event.target.value })); }} /></label>
      <div className={styles.toolbar}><button type="submit" disabled={blocked}>Create review</button><button type="button" disabled={blocked} onClick={() => { if (epoch.current !== generation || blocked) return; advance(); setCreating(false); setStartDraft({ employeePersonId: "", cycle: "", dueDate: "" }); }}>Cancel</button></div>
    </form> : null}
    <div className={styles.columns}>
      <nav aria-label="Review list">{workspace?.reviews.map(row => <button type="button" key={row.id} disabled={operation !== null} aria-pressed={row.id === selectedId} onClick={() => { if (epoch.current === generation && !operationRef.current) choose(row); }}>{row.code} — {row.employee.name} — {row.cycle}</button>)}</nav>
      {selected ? <article className={styles.card}><h2>{selected.employee.name} — {selected.employee.company}</h2>
        {selected.capabilities.downloadDocument ? <button type="button" disabled={busy} onClick={() => download()}>Download Word</button> : null}
        <p>{selected.cycle} · {selected.dueDate} · {selected.selfStatus === "awaiting_employee" ? "Awaiting employee" : "Manager review"}</p>
        <form aria-label="Self assessment" onSubmit={event => { event.preventDefault(); void run("submit_self"); }}><h2>Self assessment</h2>
          {QUESTIONS[selected.employee.company].map((prompt: string, index: number) => <label key={prompt}>{prompt}<textarea name={`self-${index}`} maxLength={8000} value={answers[index] ?? ""} disabled={selfDisabled} onChange={event => { if (!selfDisabled && epoch.current === generation) { dirty.current = true; setAnswers(current => current.map((value, i) => i === index ? event.target.value : value)); } }} /></label>)}
          {selected.audience === "employee" ? <div className={styles.toolbar}><button type="button" disabled={selfDisabled} onClick={() => run("save_self")}>Save self draft</button><button type="submit" disabled={blocked || !selected.capabilities.submitSelf || Boolean(selected.selfSubmittedAt)}>Submit self assessment</button></div> : null}
        </form>
        {selected.audience !== "employee" && assessment ? <form aria-label="Manager assessment" onSubmit={event => { event.preventDefault(); void run("complete_manager"); }}><h2>Manager assessment</h2>
          {QUESTIONS[selected.employee.company].map((prompt: string, index: number) => <div key={prompt}>
            <label>{prompt}<textarea name={`manager-${index}`} maxLength={8000} value={assessment.answers[index] ?? ""} disabled={managerDisabled} onChange={event => { if (!managerDisabled && epoch.current === generation) { dirty.current = true; dirtyParts.current.assessment = true; setAssessmentDirty(true); setAssessment(current => current ? { ...current, answers: current.answers.map((value, i) => i === index ? event.target.value : value) } : null); } }} /></label>
            {RATED.includes(index) ? <label>Manager rating<select name={`rating-${index}`} disabled={managerDisabled} value={assessment.ratings[index] ?? ""} onChange={event => { if (!managerDisabled && epoch.current === generation) { dirty.current = true; dirtyParts.current.assessment = true; setAssessmentDirty(true); setAssessment(current => current ? { ...current, ratings: current.ratings.map((value, i) => i === index ? event.target.value : value) } : null); } }}><option value="">Select rating</option>{RATINGS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label> : null}
          </div>)}
          <label>Overall manager assessment<textarea name="summary" maxLength={8000} value={assessment.summary} disabled={managerDisabled} onChange={event => { if (!managerDisabled && epoch.current === generation) { dirty.current = true; dirtyParts.current.assessment = true; setAssessmentDirty(true); setAssessment(current => current ? { ...current, summary: event.target.value } : null); } }} /></label>
          <label>Overall rating<select name="overallRating" value={assessment.overallRating} disabled={managerDisabled} onChange={event => { if (!managerDisabled && epoch.current === generation) { dirty.current = true; dirtyParts.current.assessment = true; setAssessmentDirty(true); setAssessment(current => current ? { ...current, overallRating: event.target.value } : null); } }}><option value="">Select rating</option>{RATINGS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>Private manager note<textarea name="managerNote" maxLength={8000} value={assessment.managerNote} disabled={managerDisabled} onChange={event => { if (!managerDisabled && epoch.current === generation) { dirty.current = true; dirtyParts.current.assessment = true; setAssessmentDirty(true); setAssessment(current => current ? { ...current, managerNote: event.target.value } : null); } }} /></label>
          {selected.audience === "manager" ? <div className={styles.toolbar}><button type="button" disabled={managerDisabled} onClick={() => run("save_manager")}>Save manager draft</button><button type="submit" disabled={blocked || !selected.capabilities.completeManager || Boolean(selected.finalisedAt)}>Complete manager assessment</button></div> : null}
        </form> : null}
        {selected.audience !== "employee" ? <form aria-label="Review meeting" onSubmit={event => { event.preventDefault(); void run("submit_review"); }}><h2>Review meeting</h2>
          <label>Date<input type="date" name="meeting-date" value={meeting.date} disabled={meetingDisabled} onChange={event => { if (!meetingDisabled && epoch.current === generation) { dirty.current = true; dirtyParts.current.meeting = true; setMeeting(current => ({ ...current, date: event.target.value })); } }} /></label>
          <label>Time (Melbourne)<input type="time" name="meeting-time" value={meeting.time} disabled={meetingDisabled} onChange={event => { if (!meetingDisabled && epoch.current === generation) { dirty.current = true; dirtyParts.current.meeting = true; setMeeting(current => ({ ...current, time: event.target.value })); } }} /></label>
          <label>Duration (minutes)<input type="number" min={5} max={480} name="meeting-duration" value={meeting.duration} disabled={meetingDisabled} onChange={event => { if (!meetingDisabled && epoch.current === generation) { dirty.current = true; dirtyParts.current.meeting = true; setMeeting(current => ({ ...current, duration: Number(event.target.value) })); } }} /></label>
          <label>Mode<select name="meeting-mode" value={meeting.mode} disabled={meetingDisabled} onChange={event => { if (!meetingDisabled && epoch.current === generation) { dirty.current = true; dirtyParts.current.meeting = true; setMeeting(current => ({ ...current, mode: event.target.value as PerformanceMeeting["mode"] })); } }}><option value="in_person">In person</option><option value="teams">Teams</option><option value="phone">Phone</option></select></label>
          <label>Location<input name="meeting-location" maxLength={8000} value={meeting.location} disabled={meetingDisabled} onChange={event => { if (!meetingDisabled && epoch.current === generation) { dirty.current = true; dirtyParts.current.meeting = true; setMeeting(current => ({ ...current, location: event.target.value })); } }} /></label>
          <label>Meeting notes<textarea name="meeting-notes" maxLength={8000} value={meeting.notes} disabled={meetingDisabled} onChange={event => { if (!meetingDisabled && epoch.current === generation) { dirty.current = true; dirtyParts.current.meeting = true; setMeeting(current => ({ ...current, notes: event.target.value })); } }} /></label>
          {selected.audience === "manager" ? <><label><input type="checkbox" name="held" checked={held} disabled={blocked || Boolean(selected.finalisedAt)} onChange={event => { if (epoch.current === generation && !blocked) setHeld(event.target.checked); }} />Meeting was held</label><div className={styles.toolbar}><button type="button" disabled={meetingDisabled} onClick={() => run("save_meeting")}>Save meeting</button><button type="submit" disabled={blocked || assessmentDirty || !held || !selected.managerCompletedAt || !selected.capabilities.submitReview || Boolean(selected.finalisedAt)}>Finalise review</button></div></> : null}
          {selected.managerCompletedAt ? <p>Assessment completed: {selected.managerCompletedAt}</p> : null}{selected.finalisedAt ? <p>Finalised: {selected.finalisedAt}</p> : null}
        </form> : null}
      </article> : null}
    </div>
  </section>;
}
