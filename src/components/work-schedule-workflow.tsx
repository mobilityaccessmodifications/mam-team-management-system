"use client";

import {
  AlertTriangle,
  CalendarClock,
  Check,
  Clock3,
  Pencil,
  RefreshCw,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type RefObject,
  useId,
  useRef,
  useState,
} from "react";

import styles from "@/components/work-schedule-workflow.module.css";
import { MotionLoader } from "@/components/ui/motion-loader";
import { useDialogFocus } from "@/components/ui/use-dialog-focus";
import type {
  EmployeeWorkingDayTime,
  EmployeeWorkingWeekday,
} from "@/lib/employee-directory-types";
import type {
  WorkScheduleMutationResult,
  WorkScheduleReviewItem,
  WorkScheduleWorkspace,
} from "@/lib/work-schedule-types";

const weekdays: { value: EmployeeWorkingWeekday; short: string; long: string }[] = [
  { value: 1, short: "Mon", long: "Monday" },
  { value: 2, short: "Tue", long: "Tuesday" },
  { value: 3, short: "Wed", long: "Wednesday" },
  { value: 4, short: "Thu", long: "Thursday" },
  { value: 5, short: "Fri", long: "Friday" },
  { value: 6, short: "Sat", long: "Saturday" },
  { value: 7, short: "Sun", long: "Sunday" },
];

type RequestHandler = (
  workingWeekdays: EmployeeWorkingWeekday[],
  workingDayTimes: EmployeeWorkingDayTime[],
  reason: string,
) => Promise<WorkScheduleMutationResult>;

type ReviewHandler = (
  requestId: string,
  decision: "approved" | "declined",
  reason: string,
) => Promise<WorkScheduleMutationResult>;

type WorkflowProps = {
  workspace: WorkScheduleWorkspace | null;
  loading: boolean;
  error: string;
  onRefresh: () => void | Promise<void>;
  onRequest: RequestHandler;
  onReview: ReviewHandler;
};

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

type TimeDraft = Partial<Record<EmployeeWorkingWeekday, {
  startTime: string;
  endTime: string;
}>>;

function sameSchedule(
  firstDays: EmployeeWorkingWeekday[] | null,
  firstTimes: EmployeeWorkingDayTime[],
  secondDays: EmployeeWorkingWeekday[],
  secondTimes: EmployeeWorkingDayTime[],
) {
  if (!firstDays || firstDays.length !== secondDays.length) return false;
  if (!firstDays.every((day, index) => day === secondDays[index])) return false;
  if (firstTimes.length !== secondTimes.length) return false;
  return firstTimes.every((time, index) => {
    const other = secondTimes[index];
    return time.weekday === other.weekday
      && time.startTime === other.startTime
      && time.endTime === other.endTime;
  });
}

function formatTime(value: string) {
  const [hourValue, minute] = value.split(":");
  const hour = Number(hourValue);
  if (!Number.isInteger(hour) || !minute) return value;
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${minute} ${hour < 12 ? "am" : "pm"}`;
}

function timeForDay(value: EmployeeWorkingDayTime[], weekday: EmployeeWorkingWeekday) {
  return value.find((time) => time.weekday === weekday) ?? null;
}

function daySummary(
  value: EmployeeWorkingWeekday[] | null,
  times: EmployeeWorkingDayTime[] = [],
) {
  if (!value?.length) return "Not recorded";
  return weekdays.filter((day) => value.includes(day.value)).map((day) => {
    const time = timeForDay(times, day.value);
    return time
      ? `${day.short} ${formatTime(time.startTime)}–${formatTime(time.endTime)}`
      : day.short;
  }).join(" · ");
}

function historyStatusLabel(status: WorkScheduleReviewItem["status"]) {
  if (status === "submitted") return "Awaiting review";
  return status[0].toLocaleUpperCase() + status.slice(1);
}

function DayChips({
  value,
  times,
}: {
  value: EmployeeWorkingWeekday[] | null;
  times: EmployeeWorkingDayTime[];
}) {
  if (!value?.length) return <span className={styles.notRecorded}>Not recorded</span>;
  return <div className={styles.dayChips} aria-label={daySummary(value, times)}>
    {weekdays.filter((day) => value.includes(day.value)).map((day) => {
      const time = timeForDay(times, day.value);
      return <span key={day.value}>
        <strong>{day.short}</strong>
        {time ? <small>{formatTime(time.startTime)}–{formatTime(time.endTime)}</small> : null}
      </span>;
    })}
  </div>;
}

function IconButton({
  label,
  title,
  disabled,
  onClick,
  children,
}: {
  label: string;
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return <button
    className={styles.iconButton}
    type="button"
    aria-label={label}
    title={title}
    disabled={disabled}
    onClick={onClick}
  >{children}</button>;
}

function ModalFrame({
  open,
  dialogRef,
  titleId,
  onClose,
  children,
}: {
  open: boolean;
  dialogRef: RefObject<HTMLElement | null>;
  titleId: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return <div className={styles.modalLayer}>
    <button className={styles.backdrop} type="button" tabIndex={-1} onClick={onClose} aria-label="Close dialog" />
    <section
      className={styles.modal}
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
    >{children}</section>
  </div>;
}

function ScheduleCard({
  workspace,
  onRequest,
}: {
  workspace: WorkScheduleWorkspace;
  onRequest: RequestHandler;
}) {
  const [requestOpen, setRequestOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedDays, setSelectedDays] = useState<EmployeeWorkingWeekday[]>([]);
  const [selectedTimes, setSelectedTimes] = useState<TimeDraft>({});
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const requestDialogRef = useRef<HTMLElement>(null);
  const historyDialogRef = useRef<HTMLElement>(null);
  const requestReasonRef = useRef<HTMLTextAreaElement>(null);
  const timeInputRefs = useRef<Partial<Record<EmployeeWorkingWeekday, HTMLInputElement | null>>>({});
  const firstDayRef = useRef<HTMLButtonElement>(null);
  const requestTitleId = useId();
  const historyTitleId = useId();
  const pendingRequest = workspace.history.find((item) => item.status === "submitted");

  const closeRequest = () => {
    if (busy) return;
    setRequestOpen(false);
    setError("");
  };
  const closeHistory = () => setHistoryOpen(false);
  useDialogFocus(requestOpen, requestDialogRef, null, closeRequest);
  useDialogFocus(historyOpen, historyDialogRef, null, closeHistory);

  function openRequest() {
    const current = workspace.workingWeekdays;
    setSelectedDays(current?.length ? [...current] : [1, 2, 3, 4, 5]);
    setSelectedTimes(Object.fromEntries(workspace.workingDayTimes.map((time) => [
      time.weekday,
      { startTime: time.startTime, endTime: time.endTime },
    ])) as TimeDraft);
    setReason("");
    setError("");
    setRequestOpen(true);
  }

  function toggleDay(day: EmployeeWorkingWeekday) {
    setError("");
    const removing = selectedDays.includes(day);
    setSelectedDays((current) => current.includes(day)
      ? current.filter((candidate) => candidate !== day)
      : [...current, day].sort((first, second) => first - second));
    if (removing) {
      setSelectedTimes((times) => {
        const next = { ...times };
        delete next[day];
        return next;
      });
    }
  }

  function updateTime(
    day: EmployeeWorkingWeekday,
    field: "startTime" | "endTime",
    value: string,
  ) {
    setSelectedTimes((current) => ({
      ...current,
      [day]: {
        startTime: current[day]?.startTime ?? "",
        endTime: current[day]?.endTime ?? "",
        [field]: value,
      },
    }));
    setError("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!selectedDays.length) {
      setError("Choose at least one work day.");
      firstDayRef.current?.focus();
      return;
    }
    const nextTimes: EmployeeWorkingDayTime[] = [];
    const timePattern = /^(?:[01]\d|2[0-3]):(?:00|15|30|45)$/;
    for (const day of selectedDays) {
      const draft = selectedTimes[day];
      const startTime = draft?.startTime ?? "";
      const endTime = draft?.endTime ?? "";
      if (!startTime && !endTime) continue;
      if (!startTime || !endTime) {
        setError("Choose both a start time and a finish time, or leave both blank.");
        timeInputRefs.current[day]?.focus();
        return;
      }
      if (!timePattern.test(startTime) || !timePattern.test(endTime)) {
        setError("Choose work times in 15-minute intervals.");
        timeInputRefs.current[day]?.focus();
        return;
      }
      if (endTime <= startTime) {
        setError("Finish time must be later than start time.");
        timeInputRefs.current[day]?.focus();
        return;
      }
      nextTimes.push({ weekday: day, startTime, endTime });
    }
    if (sameSchedule(
      workspace.workingWeekdays,
      workspace.workingDayTimes,
      selectedDays,
      nextTimes,
    )) {
      setError("Choose a schedule that is different from your current work days or times.");
      firstDayRef.current?.focus();
      return;
    }
    if (!workspace.initialSetupAvailable && !reason.trim()) {
      setError("Tell your manager why the schedule needs to change.");
      requestReasonRef.current?.focus();
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await onRequest(selectedDays, nextTimes, reason);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setRequestOpen(false);
    } catch {
      setError("The request could not be sent. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return <>
    <section className={styles.scheduleCard} aria-label="Your work schedule">
      <div className={styles.scheduleIcon}><CalendarClock size={19} aria-hidden="true" /></div>
      <div className={styles.scheduleCopy}>
        <span>Work schedule</span>
        <DayChips value={workspace.workingWeekdays} times={workspace.workingDayTimes} />
        {workspace.initialSetupAvailable ? <small>Your first schedule saves immediately.</small> : null}
        {pendingRequest ? <small>Change awaiting review</small> : null}
      </div>
      <div className={styles.scheduleActions}>
        <IconButton
          label="View work schedule history"
          title="History"
          disabled={!workspace.history.length}
          onClick={() => setHistoryOpen(true)}
        ><Clock3 size={18} aria-hidden="true" /></IconButton>
        <IconButton
          label={workspace.initialSetupAvailable ? "Set your work schedule" : "Request a work schedule change"}
          title={workspace.canRequestChange
            ? workspace.initialSetupAvailable ? "Set schedule" : "Request change"
            : "A request is already awaiting review"}
          disabled={!workspace.canRequestChange}
          onClick={openRequest}
        ><Pencil size={18} aria-hidden="true" /></IconButton>
      </div>
    </section>

    <ModalFrame open={requestOpen} dialogRef={requestDialogRef} titleId={requestTitleId} onClose={closeRequest}>
      <form className={styles.form} onSubmit={submit}>
        <header className={styles.modalHeader}>
          <div><span>Work schedule</span><h2 id={requestTitleId}>{workspace.initialSetupAvailable ? "Set your schedule" : "Request a change"}</h2></div>
          <button type="button" onClick={closeRequest} disabled={busy} aria-label="Close request"><X size={19} /></button>
        </header>
        <div className={styles.modalBody}>
          {workspace.initialSetupAvailable
            ? <div className={styles.initialSetupNote}>
                <Check size={17} aria-hidden="true" />
                <span>This is your first schedule, so it will save immediately without manager approval.</span>
              </div>
            : <div className={styles.changeSummary}>
                <span>Current</span><strong>{daySummary(workspace.workingWeekdays, workspace.workingDayTimes)}</strong>
              </div>}
          <fieldset className={styles.dayPicker}>
            <legend>{workspace.initialSetupAvailable ? "Usual work days" : "Proposed work days"}</legend>
            <div>{weekdays.map((day) => <button
              key={day.value}
              ref={day.value === 1 ? firstDayRef : undefined}
              type="button"
              aria-label={day.long}
              aria-pressed={selectedDays.includes(day.value)}
              onClick={() => toggleDay(day.value)}
            ><span>{day.short}</span><small>{day.long}</small></button>)}</div>
          </fieldset>
          <fieldset className={styles.timePicker}>
            <legend>Optional start and finish times</legend>
            <p>Set hours only where they are fixed. Leave both fields blank for a day with no exact time.</p>
            <div className={styles.timeRows}>{selectedDays.map((day) => {
              const option = weekdays.find((candidate) => candidate.value === day);
              return <div className={styles.timeRow} key={day}>
                <strong>{option?.long}</strong>
                <label>
                  <span>Start</span>
                  <input
                    ref={(node) => { timeInputRefs.current[day] = node; }}
                    type="time"
                    step={900}
                    value={selectedTimes[day]?.startTime ?? ""}
                    onChange={(event) => updateTime(day, "startTime", event.target.value)}
                  />
                </label>
                <label>
                  <span>Finish</span>
                  <input
                    type="time"
                    step={900}
                    value={selectedTimes[day]?.endTime ?? ""}
                    onChange={(event) => updateTime(day, "endTime", event.target.value)}
                  />
                </label>
              </div>;
            })}</div>
          </fieldset>
          {!workspace.initialSetupAvailable ? <label className={styles.reasonField}>
              <span>Reason</span>
              <textarea
                ref={requestReasonRef}
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                  setError("");
                }}
                maxLength={1000}
                rows={4}
                required
                placeholder="Why do you need this change?"
              />
            </label> : null}
          {error ? <p className={styles.error} role="alert"><AlertTriangle size={16} />{error}</p> : null}
        </div>
        <footer className={styles.modalFooter}>
          <button className={styles.secondaryButton} type="button" onClick={closeRequest} disabled={busy}>Cancel</button>
          <button className={styles.primaryButton} type="submit" disabled={busy}>{busy
            ? workspace.initialSetupAvailable ? "Saving…" : "Sending…"
            : workspace.initialSetupAvailable ? "Save schedule" : "Send request"}</button>
        </footer>
      </form>
    </ModalFrame>

    <ModalFrame open={historyOpen} dialogRef={historyDialogRef} titleId={historyTitleId} onClose={closeHistory}>
      <header className={styles.modalHeader}>
        <div><span>Work schedule</span><h2 id={historyTitleId}>Change history</h2></div>
        <button type="button" onClick={closeHistory} aria-label="Close history"><X size={19} /></button>
      </header>
      <div className={`${styles.modalBody} ${styles.historyList}`}>
        {workspace.history.map((item) => <article key={item.id}>
          <header><strong>{daySummary(item.originalWorkingWeekdays, item.originalWorkingDayTimes)} <span aria-hidden="true">→</span> {daySummary(item.requestedWorkingWeekdays, item.requestedWorkingDayTimes)}</strong><span data-status={item.status}>{historyStatusLabel(item.status)}</span></header>
          <p>{item.requestReason}</p>
          <small>Submitted {formatDate(item.submittedAt)} · {item.submittedByName}</small>
          {item.decidedAt ? <small>{historyStatusLabel(item.status)} {formatDate(item.decidedAt)}{item.reviewerName ? ` · ${item.reviewerName}` : ""}</small> : null}
          {item.decisionReason ? <blockquote>{item.decisionReason}</blockquote> : null}
        </article>)}
      </div>
      <footer className={styles.modalFooter}><button className={styles.secondaryButton} type="button" onClick={closeHistory}>Close</button></footer>
    </ModalFrame>
  </>;
}

function ReviewQueue({
  reviews,
  compact,
  onReview,
}: {
  reviews: WorkScheduleReviewItem[];
  compact: boolean;
  onReview: ReviewHandler;
}) {
  const [selectedId, setSelectedId] = useState("");
  const [decision, setDecision] = useState<"approved" | "declined">("approved");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const headingId = useId();
  const visibleReviews = compact ? reviews.slice(0, 3) : reviews;
  const reviewIds = reviews.map((item) => item.id).join(":");
  const [previousReviewIds, setPreviousReviewIds] = useState(reviewIds);
  const selected = reviews.find((item) => item.id === selectedId) ?? null;

  // Adjust stale selection while rendering the new review snapshot. This is
  // derived-state reset (not an external-system effect), and prevents a modal
  // draft from reviving if the request leaves scope and later reappears.
  if (reviewIds !== previousReviewIds) {
    setPreviousReviewIds(reviewIds);
    if (selectedId && !selected) {
      setSelectedId("");
      setReason("");
      setError("");
    }
  }

  const close = () => {
    if (busy) return;
    setSelectedId("");
    setError("");
  };
  useDialogFocus(Boolean(selected), dialogRef, null, close);

  function open(item: WorkScheduleReviewItem, nextDecision: "approved" | "declined") {
    if (busy) return;
    setSelectedId(item.id);
    setDecision(nextDecision);
    setReason("");
    setError("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || busy) return;
    if (!reason.trim()) {
      setError(`Enter a reason to ${decision === "approved" ? "approve" : "decline"} this request.`);
      reasonRef.current?.focus();
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await onReview(selected.id, decision, reason);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setSelectedId("");
    } catch {
      setError("The decision could not be saved. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!reviews.length) return null;
  return <>
    <section className={styles.reviewQueue} aria-labelledby={headingId}>
      <header><div><span>Manager action</span><h2 id={headingId}>Schedule requests</h2></div><strong>{reviews.length}</strong></header>
      <div className={styles.reviewRows}>
        {visibleReviews.map((item) => <article key={item.id}>
          <div><strong>{item.employeeName}</strong><span>{daySummary(item.originalWorkingWeekdays, item.originalWorkingDayTimes)} <i aria-hidden="true">→</i> {daySummary(item.requestedWorkingWeekdays, item.requestedWorkingDayTimes)}</span><small>{item.requestReason}</small></div>
          <div className={styles.reviewActions}>
            <button type="button" data-decision="declined" disabled={busy} onClick={() => open(item, "declined")}>Decline</button>
            <button type="button" data-decision="approved" disabled={busy} onClick={() => open(item, "approved")}><Check size={16} aria-hidden="true" />Approve</button>
          </div>
        </article>)}
      </div>
      {compact && reviews.length > visibleReviews.length ? <small className={styles.moreRequests}>+{reviews.length - visibleReviews.length} more in Tasks</small> : null}
    </section>

    <ModalFrame open={Boolean(selected)} dialogRef={dialogRef} titleId={titleId} onClose={close}>
      {selected ? <form className={styles.form} onSubmit={submit}>
        <header className={styles.modalHeader}>
          <div><span>Work schedule</span><h2 id={titleId}>{decision === "approved" ? "Approve" : "Decline"} {selected.employeeName}&apos;s request?</h2></div>
          <button type="button" onClick={close} disabled={busy} aria-label="Close review"><X size={19} /></button>
        </header>
        <div className={styles.modalBody}>
          <div className={styles.decisionOverview}>
            <div><span>Current</span><strong>{daySummary(selected.originalWorkingWeekdays, selected.originalWorkingDayTimes)}</strong></div>
            <div><span>Proposed</span><strong>{daySummary(selected.requestedWorkingWeekdays, selected.requestedWorkingDayTimes)}</strong></div>
            <blockquote>{selected.requestReason}</blockquote>
          </div>
          <label className={styles.reasonField}>
            <span>{decision === "approved" ? "Approval" : "Decline"} reason</span>
            <textarea ref={reasonRef} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} rows={4} required />
          </label>
          {error ? <p className={styles.error} role="alert"><AlertTriangle size={16} />{error}</p> : null}
        </div>
        <footer className={styles.modalFooter}>
          <button className={styles.secondaryButton} type="button" onClick={close} disabled={busy}>Cancel</button>
          <button className={decision === "approved" ? styles.primaryButton : styles.declineButton} type="submit" disabled={busy}>{busy ? "Saving…" : decision === "approved" ? "Approve request" : "Decline request"}</button>
        </footer>
      </form> : null}
    </ModalFrame>
  </>;
}

function LoadState({
  loading,
  error,
  onRefresh,
}: {
  loading: boolean;
  error: string;
  onRefresh: () => void | Promise<void>;
}) {
  if (loading) return <div className={styles.loadState}><MotionLoader label="Loading work schedule" /></div>;
  if (!error) return null;
  return <div className={styles.loadError} role="alert"><AlertTriangle size={17} /><span>{error}</span><button type="button" onClick={() => void onRefresh()}><RefreshCw size={16} />Retry</button></div>;
}

export function WorkScheduleHome(props: WorkflowProps) {
  const { workspace, loading, error, onRefresh, onRequest, onReview } = props;
  if (!workspace) return <LoadState loading={loading} error={error} onRefresh={onRefresh} />;
  return <div className={styles.homeWorkflow}>
    {error ? <LoadState loading={false} error={error} onRefresh={onRefresh} /> : null}
    {workspace.activePersonId ? <ScheduleCard workspace={workspace} onRequest={onRequest} /> : null}
    <ReviewQueue reviews={workspace.reviews} compact onReview={onReview} />
  </div>;
}

export function WorkScheduleTasks(props: WorkflowProps & { showReviews?: boolean }) {
  const { workspace, loading, error, onRefresh, onRequest, onReview } = props;
  if (!workspace) return <LoadState loading={loading} error={error} onRefresh={onRefresh} />;
  return <div className={styles.taskWorkflow}>
    {error ? <LoadState loading={false} error={error} onRefresh={onRefresh} /> : null}
    {workspace.activePersonId ? <ScheduleCard workspace={workspace} onRequest={onRequest} /> : null}
    {props.showReviews !== false ? <ReviewQueue reviews={workspace.reviews} compact={false} onReview={onReview} /> : null}
  </div>;
}
