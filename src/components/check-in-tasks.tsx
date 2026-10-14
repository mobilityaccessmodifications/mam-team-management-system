"use client";

import { AlertTriangle, CalendarCheck2, CheckCircle2, ChevronLeft, ChevronRight, CircleAlert, ListChecks, PanelLeftClose, PanelLeftOpen, RotateCcw, Search, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { completeMyEmployeeCheckInTask } from "@/app/check-in-tasks/actions";
import styles from "@/components/check-in-tasks.module.css";
import toolbar from "@/components/people-toolbar.module.css";
import { useSubscriptionReviewTasks } from "@/components/subscription-review-tasks";
import { TaskNotesEditor, type TaskNoteDraft } from "@/components/task-notes-editor";
import { CHECK_IN_TASK_LOAD_ERROR, parseCheckInTasks } from "@/lib/check-in-tasks-data";
import type { CheckInTask } from "@/lib/check-in-tasks-types";
import type { SubscriptionReviewTask } from "@/lib/subscription-review-tasks";
import type { TaskNotesTarget } from "@/lib/task-notes-types";
import type { WorkScheduleHistoryItem, WorkScheduleMutationResult, WorkScheduleWorkspace } from "@/lib/work-schedule-types";
import type { EmployeeWorkingDayTime, EmployeeWorkingWeekday } from "@/lib/employee-directory-types";
import { createClient as createSupabaseClient } from "@/lib/supabase/client";
import { MotionLoader } from "@/components/ui/motion-loader";
import { useDialogFocus } from "@/components/ui/use-dialog-focus";
import { useMediaQuery } from "@/components/ui/use-media-query";

function formatDate(value: string) {
  const parsed = new Date(value.includes("T") ? value : `${value}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Melbourne", day: "numeric", month: "short", year: "numeric" }).format(parsed);
}

function milestoneLabel(value: CheckInTask["milestone"]) {
  if (value === "2_week") return "2-week check-in";
  if (value === "1_month") return "1-month check-in";
  if (value === "2_month") return "2-month stay interview";
  if (value === "3_month") return "3-month check-in";
  if (value === "6_month_casual") return "6-month casual check-in";
  if (value === "6_month") return "6-month check-in";
  return "5-Month No-Surprises Review";
}

function statusLabel(value: string) {
  if (value === "scheduled") return "Scheduled";
  if (value === "claimed") return "Sending reminder";
  if (value === "delivered") return "Ready";
  if (value === "needs_review") return "Needs review";
  if (value === "submitted") return "Pending approval";
  return value === "paused" ? "Paused" : "Active";
}

function scheduleSummary(days: EmployeeWorkingWeekday[] | null, times: EmployeeWorkingDayTime[]) {
  const names = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return days?.length ? days.map((day) => {
    const time = times.find((item) => item.weekday === day);
    return `${names[day]}${time?.startTime && time.endTime ? ` ${time.startTime}–${time.endTime}` : ""}`;
  }).join(", ") : "Not recorded";
}
const reviewReasonCopy: Record<string, { title: string; detail: string; nextStep: string }> = {
  historic_cutover: {
    title: "Historic milestone",
    detail: "This reminder was created from an existing employee record during the check-in rollout.",
    nextStep: "HR should review the record before deciding whether to queue a catch-up reminder.",
  },
  not_enrolled: {
    title: "Automatic reminders are not enabled",
    detail: "This employee has not been enrolled in the automatic check-in reminder schedule.",
    nextStep: "HR needs to enable reminders for this employee before an email can be sent.",
  },
  missing_manager_email: {
    title: "Manager work email is missing",
    detail: "The system could not find a work email for the employee's current manager.",
    nextStep: "Add the manager's work email to their profile, then refresh the task list.",
  },
  start_date_changed_after_delivery: {
    title: "Start date changed after delivery",
    detail: "The employee's start date changed after a reminder had already been delivered.",
    nextStep: "Review the new milestone dates and confirm whether another reminder is needed.",
  },
  context_changed: {
    title: "Employee details changed",
    detail: "The employee or reporting line changed while this reminder was scheduled.",
    nextStep: "Review the employee's current manager and milestone schedule before sending anything.",
  },
  retry_exhausted: {
    title: "Delivery retry limit reached",
    detail: "The reminder could not be delivered after the configured retry attempts.",
    nextStep: "Check the delivery setup and ask HR to queue a catch-up once it is ready.",
  },
  missed_delivery: {
    title: "Scheduled notification date has passed",
    detail: "The automatic reminder was not sent on its scheduled notification date.",
    nextStep: "HR should review the missed reminder and queue a catch-up if appropriate.",
  },
};

function reviewReasonCopyFor(task: CheckInTask) {
  return task.needsReviewReason
    ? reviewReasonCopy[task.needsReviewReason] ?? {
      title: "Manual review required",
      detail: "Automatic delivery is paused because the reminder needs an authorised review.",
      nextStep: "Ask HR to review the employee record and reminder schedule.",
    }
    : {
      title: "Manual review required",
      detail: "Automatic delivery is paused, but no specific reason was recorded for this reminder.",
      nextStep: "Ask HR to review the employee record and reminder schedule.",
    };
}

type TaskItem = {
  key: string;
  target: TaskNotesTarget;
  title: string;
  name: string;
  context: string;
  date: string;
  status: string;
  checkIn?: CheckInTask;
  subscription?: SubscriptionReviewTask;
  schedule?: WorkScheduleHistoryItem;
  canReview?: boolean;
};

const tasksPerPage = 8;

export function CheckInTasks({ previewPersonId, readOnly = false, toolbarAction, scheduleContent, showCheckInTasks = true, showSubscriptionReviewTasks = true, workScheduleWorkspace, onScheduleReview, onScheduleRefresh }: {
  previewPersonId?: string;
  readOnly?: boolean;
  toolbarAction?: ReactNode;
  scheduleContent?: ReactNode;
  showCheckInTasks?: boolean;
  showSubscriptionReviewTasks?: boolean;
  workScheduleWorkspace?: WorkScheduleWorkspace | null;
  onScheduleRefresh?: () => void | Promise<void>;
  onScheduleReview?: (requestId: string, decision: "approved" | "declined", reason: string) => Promise<WorkScheduleMutationResult>;
} = {}) {
  const [checkIns, setCheckIns] = useState<CheckInTask[]>([]);
  const [loading, setLoading] = useState(showCheckInTasks);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingId, setPendingId] = useState("");
  const [selectedKey, setSelectedKey] = useState("");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sort, setSort] = useState("date");
  const [page, setPage] = useState(1);
  const [listCollapsed, setListCollapsed] = useState(false);
  const recordsId = useId();
  const [notesBusy, setNotesBusy] = useState(false);
  const [notesBlocked, setNotesBlocked] = useState(true);
  const pending = useRef(false);
  const generation = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const [drafts] = useState(() => new Map<string, TaskNoteDraft>());
  const mobile = useMediaQuery("(max-width: 900px)");
  const collapsed = listCollapsed && !mobile;
  const notesReadOnly = readOnly || Boolean(previewPersonId);
  const subscriptions = useSubscriptionReviewTasks({ previewPersonId, readOnly: notesReadOnly, enabled: showSubscriptionReviewTasks });
  const busy = notesBusy || Boolean(pendingId) || Boolean(subscriptions.pendingId);

  const load = useCallback(async () => {
    const request = ++generation.current;
    setLoading(showCheckInTasks);
    setError("");
    if (!showCheckInTasks) { setCheckIns([]); setLoading(false); return; }
    try {
      const supabase = createSupabaseClient();
      const { data: raw, error: failure } = previewPersonId
        ? await supabase.rpc("list_employee_check_in_tasks_for_preview", { p_person_id: previewPersonId })
        : await supabase.rpc("list_my_employee_check_in_tasks");
      if (failure) throw new Error(failure.code === "42501" ? "You do not have permission to view check-in tasks." : CHECK_IN_TASK_LOAD_ERROR);
      const result = parseCheckInTasks(raw);
      if (request === generation.current) setCheckIns(result.tasks);
    } catch (failure) {
      if (request === generation.current) { setCheckIns([]); setError(failure instanceof Error ? failure.message : CHECK_IN_TASK_LOAD_ERROR); }
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [previewPersonId, showCheckInTasks]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => { window.clearTimeout(timer); generation.current += 1; };
  }, [load]);

  const tasks = useMemo<TaskItem[]>(() => {
    const result: TaskItem[] = checkIns.map((task) => ({
      key: `check_in:${task.reminderId}`, target: { kind: "check_in", taskId: task.reminderId },
      name: task.employeeName, title: milestoneLabel(task.milestone), context: `${task.positionTitle || "Role not recorded"} · ${task.company === "mam" ? "MAM" : "Equipsy"}`,
      date: task.dueDate, status: task.status, checkIn: task,
    }));
    result.push(...subscriptions.tasks.map((task) => ({
      key: `subscription_review:${task.subscriptionId}:${task.nextReviewOn}`, target: { kind: "subscription_review" as const, taskId: task.subscriptionId, reviewOn: task.nextReviewOn },
      name: task.serviceName, title: "Quarterly subscription review", context: "Subscription review", date: task.nextReviewOn, status: task.status, subscription: task,
    })));
    const reviews = workScheduleWorkspace?.reviews ?? [];
    const schedules = new Map(reviews.map((item) => [item.id, { item, name: item.employeeName, canReview: true }]));
    for (const item of workScheduleWorkspace?.history ?? []) {
      if (item.status === "submitted" && !schedules.has(item.id)) schedules.set(item.id, { item: { ...item, personId: workScheduleWorkspace?.activePersonId ?? "", employeeName: workScheduleWorkspace?.activePersonName ?? "Your schedule" }, name: workScheduleWorkspace?.activePersonName ?? "Your schedule", canReview: false });
    }
    for (const { item, name, canReview } of schedules.values()) {
      if (item.status === "submitted") result.push({ key: `work_schedule:${item.id}`, target: { kind: "work_schedule", taskId: item.id }, name, title: "Work schedule change", context: "Schedule request", date: item.submittedAt, status: "submitted", schedule: item, canReview });
    }
    return result;
  }, [checkIns, subscriptions.tasks, workScheduleWorkspace]);
  const visibleTasks = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return tasks.filter((task) => (typeFilter === "all" || task.target.kind === typeFilter)
      && (statusFilter === "all" || task.status === (statusFilter === "ready" ? "delivered" : statusFilter))
      && (!search || `${task.name} ${task.title} ${task.context} ${statusLabel(task.status)}`.toLocaleLowerCase().includes(search)))
      .sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) || a.date.localeCompare(b.date) : a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  }, [tasks, query, typeFilter, statusFilter, sort]);
  const totalPages = Math.max(1, Math.ceil(visibleTasks.length / tasksPerPage));
  const currentPage = Math.min(page, totalPages);
  const pageTasks = visibleTasks.slice((currentPage - 1) * tasksPerPage, currentPage * tasksPerPage);
  const selected = tasks.find((task) => task.key === selectedKey);
  const close = useCallback(() => { if (!busy) { setSelectedKey(""); if (!mobile) searchRef.current?.focus(); } }, [busy, mobile]);
  useEffect(() => {
    if (!selectedKey || selected) return;
    const timer = window.setTimeout(() => { setSelectedKey(""); searchRef.current?.focus(); }, 0);
    return () => window.clearTimeout(timer);
  }, [selected, selectedKey]);
  useDialogFocus(Boolean(selected) && mobile, dialogRef, null, close, searchRef);

  async function completeCheckIn(task: CheckInTask) {
    if (readOnly || pending.current || busy || notesBlocked || !task.canComplete) return;
    pending.current = true;
    setPendingId(task.reminderId);
    setError(""); setNotice("");
    const request = generation.current;
    try {
      await completeMyEmployeeCheckInTask(task.reminderId);
      if (request !== generation.current) return;
      setCheckIns((current) => current.filter((item) => item.reminderId !== task.reminderId));
      setSelectedKey("");
      setNotice(`${task.employeeName}'s check-in is complete.`);
      searchRef.current?.focus();
      await load();
    } catch (failure) {
      if (request === generation.current) setError(failure instanceof Error ? failure.message : "The check-in task could not be marked complete. Refresh and try again.");
    } finally { pending.current = false; setPendingId(""); }
  }

  return <section className={styles.workspace} aria-label="Tasks">
    {scheduleContent}
    <header className={toolbar.toolbar} aria-label="Task actions">
      <div className={toolbar.controls}>
        <label className={toolbar.search}><Search size={17} aria-hidden="true" /><span className={styles.srOnly}>Search tasks</span><input ref={searchRef} type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} onInput={(event) => { setQuery(event.currentTarget.value); setPage(1); }} placeholder="Search tasks" /></label>
        <label className={toolbar.select}><span>Type</span><select value={typeFilter} onChange={(event) => { setTypeFilter(event.target.value); setPage(1); }}><option value="all">All types</option><option value="check_in">Check-ins</option>{showSubscriptionReviewTasks ? <option value="subscription_review">Subscription reviews</option> : null}<option value="work_schedule">Schedule requests</option></select></label>
        <label className={toolbar.select}><span>Status</span><select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }}><option value="all">All statuses</option><option value="needs_review">Needs review</option><option value="ready">Ready</option><option value="scheduled">Scheduled</option><option value="claimed">Sending reminder</option><option value="active">Active</option><option value="paused">Paused</option><option value="submitted">Pending approval</option></select></label>
        <label className={toolbar.select}><span>Sort</span><select value={sort} onChange={(event) => { setSort(event.target.value); setPage(1); }}><option value="date">Date — earliest</option><option value="name">Name A–Z</option></select></label>
      </div>
      <div className={toolbar.actions}><span className={toolbar.count}>{visibleTasks.length} tasks</span>{toolbarAction}<button className={toolbar.iconButton} type="button" aria-label="Refresh tasks" disabled={loading || subscriptions.loading || busy} onClick={() => { void load(); void subscriptions.load(); void onScheduleRefresh?.(); }}><RotateCcw size={17} aria-hidden="true" /></button></div>
    </header>
    {error || subscriptions.error ? <div className={styles.errors}>{error ? <p className={styles.error} role="alert"><AlertTriangle size={17} aria-hidden="true" />{error}</p> : null}{subscriptions.error ? <p className={styles.error} role="alert"><AlertTriangle size={17} aria-hidden="true" />{subscriptions.error}</p> : null}</div> : null}
    {notice || subscriptions.notice ? <p className={styles.notice} role="status"><CheckCircle2 size={17} aria-hidden="true" />{notice || subscriptions.notice}</p> : null}
    <div className={styles.taskDesk} data-list-collapsed={collapsed}>
      <div className={styles.taskList} aria-label="Task records">
        <header className={styles.listHeader}>
          <strong hidden={collapsed}>Tasks</strong>
          <button className={`${toolbar.iconButton} ${styles.collapseButton}`} type="button" aria-label={collapsed ? "Expand task list" : "Collapse task list"} aria-expanded={!collapsed} aria-controls={recordsId} onClick={() => setListCollapsed((current) => !current)}>{collapsed ? <PanelLeftOpen size={18} aria-hidden="true" /> : <PanelLeftClose size={18} aria-hidden="true" />}</button>
        </header>
        <div id={recordsId} className={styles.listContent} hidden={collapsed}>
        {loading || subscriptions.loading ? <div className={styles.loading}><MotionLoader label="Loading tasks" /></div> : null}
        {!visibleTasks.length && !loading && !subscriptions.loading ? <div className={styles.empty}><ListChecks size={22} aria-hidden="true" /><strong>{tasks.length ? "No tasks match these filters." : "No tasks need your action."}</strong></div> : null}
        {pageTasks.map((task) => <button className={styles.taskRow} type="button" key={task.key} data-selected={task.key === selected?.key} aria-current={task.key === selected?.key ? "true" : undefined} aria-label={`Open ${task.name}'s ${task.title}`} disabled={busy} onClick={() => { if (task.key !== selectedKey) { setNotesBlocked(true); setSelectedKey(task.key); } }}>
          <span className={styles.taskIdentity}><strong>{task.name}</strong><span>{task.title}</span><small>{task.schedule ? "Submitted" : "Due"} {formatDate(task.date)}</small></span>
          <span className={styles.rowStatus} data-status={task.status}>{task.status === "needs_review" ? <CircleAlert size={14} aria-hidden="true" /> : null}{statusLabel(task.status)}</span><ChevronRight size={16} className={styles.chevron} aria-hidden="true" />
        </button>)}
          <nav className={styles.pagination} aria-label="Task list pagination">
            <span className={styles.pageRange} aria-live="polite" aria-atomic="true">Page {currentPage} of {totalPages}</span>
            <div className={styles.paginationControls}>
              <button className={toolbar.iconButton} type="button" aria-label="Previous page" disabled={currentPage === 1 || loading || subscriptions.loading} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={16} aria-hidden="true" /></button>
              <button className={toolbar.iconButton} type="button" aria-label="Next page" disabled={currentPage === totalPages || loading || subscriptions.loading} onClick={() => setPage(currentPage + 1)}><ChevronRight size={16} aria-hidden="true" /></button>
            </div>
          </nav>
        </div>
      </div>
      {selected ? <>
        <button className={styles.detailBackdrop} type="button" disabled={busy} onClick={close} aria-label="Close task details" tabIndex={-1} />
        <section ref={dialogRef} className={styles.detail} role={mobile ? "dialog" : "region"} aria-modal={mobile ? true : undefined} aria-label="Task details" tabIndex={-1}>
          <header className={styles.detailHeader}><div><span>{selected.context}</span><h2>{selected.name}</h2></div><button className={toolbar.iconButton} type="button" disabled={busy} aria-label="Close task details" onClick={close}><X size={18} aria-hidden="true" /></button></header>
          <div className={styles.detailBody}>
            <h3>{selected.title}</h3>
            <dl className={styles.facts}><div><dt>{selected.schedule ? "Submitted" : "Due date"}</dt><dd>{formatDate(selected.date)}</dd></div><div><dt>Status</dt><dd><span className={styles.rowStatus} data-status={selected.status}>{statusLabel(selected.status)}</span></dd></div>{selected.checkIn ? <div><dt>Employee</dt><dd>{selected.name}</dd></div> : null}{selected.subscription ? <div><dt>Service</dt><dd>{selected.name}</dd></div> : null}</dl>
            {selected.checkIn?.status === "needs_review" ? <div className={styles.reviewPanel}><strong>{reviewReasonCopyFor(selected.checkIn).title}</strong><p>{reviewReasonCopyFor(selected.checkIn).detail}</p><small>{reviewReasonCopyFor(selected.checkIn).nextStep}</small></div> : null}
            {selected.schedule ? <><dl className={styles.scheduleFacts}><div><dt>Current schedule</dt><dd>{scheduleSummary(selected.schedule.originalWorkingWeekdays, selected.schedule.originalWorkingDayTimes)}</dd></div><div><dt>Requested schedule</dt><dd>{scheduleSummary(selected.schedule.requestedWorkingWeekdays, selected.schedule.requestedWorkingDayTimes)}</dd></div><div><dt>Request reason</dt><dd>{selected.schedule.requestReason}</dd></div><div><dt>Submitted by</dt><dd>{selected.schedule.submittedByName}</dd></div></dl></> : null}
            <TaskNotesEditor key={`${selected.key}:${previewPersonId ?? "self"}`} target={selected.target} previewPersonId={previewPersonId} readOnly={notesReadOnly} blocked={busy} drafts={drafts} onBusyChange={setNotesBusy} onActionsBlockedChange={setNotesBlocked} />
            {!readOnly && selected.checkIn ? <div className={styles.detailActions}><button className={toolbar.primary} type="button" disabled={busy || notesBlocked || !selected.checkIn.canComplete} aria-busy={pendingId === selected.checkIn.reminderId} aria-label={`Mark ${selected.name}'s ${selected.title} complete`} onClick={() => void completeCheckIn(selected.checkIn!)}><CalendarCheck2 size={17} aria-hidden="true" />{pendingId ? "Completing…" : "Complete check-in"}</button></div> : null}
            {!notesReadOnly && selected.subscription ? <div className={styles.detailActions}><button className={toolbar.primary} type="button" disabled={busy || notesBlocked || !selected.subscription.canComplete} aria-busy={subscriptions.pendingId === selected.subscription.subscriptionId} aria-label={`Mark ${selected.name}'s subscription review done`} onClick={() => { if (!busy && !notesBlocked) void subscriptions.complete(selected.subscription!); }}><CheckCircle2 size={17} aria-hidden="true" />{subscriptions.pendingId ? "Completing…" : "Done"}</button></div> : null}
            {!readOnly && selected.schedule && selected.canReview && onScheduleReview ? <ScheduleDecision key={selected.key} task={selected} blocked={busy || notesBlocked} onBusyChange={setNotesBusy} onReview={onScheduleReview} onSaved={(message) => { setNotice(message); setSelectedKey(""); searchRef.current?.focus(); }} /> : null}
          </div>
        </section>
      </> : <div className={styles.emptyDetail}><ListChecks size={26} aria-hidden="true" /><strong>Select a task</strong></div>}
    </div>
  </section>;
}

function ScheduleDecision({ task, blocked, onBusyChange, onReview, onSaved }: { task: TaskItem; blocked: boolean; onBusyChange: (busy: boolean) => void; onReview: NonNullable<Parameters<typeof CheckInTasks>[0]>["onScheduleReview"]; onSaved: (message: string) => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; onBusyChange(false); }, [onBusyChange]);
  async function decide(decision: "approved" | "declined") {
    if (!onReview || blocked || pending.current) return;
    if (!reason.trim()) { setError(`Enter a reason to ${decision === "approved" ? "approve" : "decline"} this request.`); return; }
    pending.current = true; setSaving(true); onBusyChange(true); setError("");
    const request = generation.current;
    try {
      const result = await onReview(task.target.taskId, decision, reason);
      if (request !== generation.current) return;
      if (!result.ok) { setError(result.message); return; }
      onSaved(`Schedule request ${decision}.`);
    } catch { if (request === generation.current) setError("The decision could not be saved. Try again."); }
    finally { pending.current = false; if (request === generation.current) { setSaving(false); onBusyChange(false); } }
  }
  return <div className={styles.scheduleDecision}><label><span>Decision reason</span><textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} rows={3} disabled={saving} /></label>{error ? <p className={styles.error} role="alert">{error}</p> : null}<div className={styles.detailActions}><button className={toolbar.button} type="button" disabled={blocked || saving} onClick={() => void decide("declined")}>Decline</button><button className={toolbar.primary} type="button" disabled={blocked || saving} onClick={() => void decide("approved")}>Approve request</button></div></div>;
}
