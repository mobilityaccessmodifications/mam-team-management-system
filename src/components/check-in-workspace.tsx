"use client";

import {
  AlertTriangle,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  UsersRound,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CheckInReviewOutcomeDialog } from "@/components/check-in-review-outcome-dialog";
import styles from "@/components/check-in-register.module.css";
import { AnimatedStatusBadge } from "@/components/ui/animated-status-badge";
import { MotionLoader } from "@/components/ui/motion-loader";
import { parseCheckInWorkspaceRecords } from "@/lib/check-in-workspace-data";
import type {
  CheckInResourceLinks,
  CheckInWorkspaceData,
  CheckInWorkspaceRecord,
  CheckInWorkspaceReminder,
} from "@/lib/check-in-register-types";
import { createClient as createSupabaseClient } from "@/lib/supabase/client";

const employeesPerPage = 8;

const emptyResources: CheckInWorkspaceData["resources"] = {
  managerGuideUrl: null,
  checkInFormUrl: null,
  probationTemplatesUrl: null,
};

type EmployeeSort = "due" | "start" | "name";

function formatDate(value: string) {
  if (!value) return "Not recorded";
  const parsed = new Date(`${value}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(parsed);
}

function milestoneLabel(value: CheckInWorkspaceReminder["milestone"]) {
  if (value === "2_week") return "2-week check-in";
  if (value === "1_month") return "1-month check-in";
  if (value === "2_month") return "2-month stay interview";
  if (value === "3_month") return "3-month check-in";
  return "5-Month No-Surprises Review";
}

function canCompleteReminder(reminder: CheckInWorkspaceReminder) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const today = `${value("year")}-${value("month")}-${value("day")}`;
  return reminder.status !== "completed"
    && reminder.status !== "claimed"
    && /^\d{4}-\d{2}-\d{2}$/.test(reminder.dueDate)
    && reminder.dueDate <= today;
}

function reminderTone(status: CheckInWorkspaceReminder["status"]): "success" | "warning" | "info" {
  if (status === "completed" || status === "delivered") return "success";
  if (status === "needs_review") return "warning";
  return "info";
}

function initials(record: CheckInWorkspaceRecord) {
  return record.fullName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.slice(0, 1))
    .join("")
    .toUpperCase() || "–";
}

function nextDueDate(record: Pick<CheckInWorkspaceRecord, "reminders">) {
  return record.reminders
    .filter((reminder) => reminder.status !== "completed" && /^\d{4}-\d{2}-\d{2}$/.test(reminder.dueDate))
    .map((reminder) => reminder.dueDate)
    .sort()[0] ?? null;
}

function sortRecords(records: CheckInWorkspaceRecord[], sort: EmployeeSort) {
  return [...records].sort((left, right) => {
    if (sort === "name") {
      return left.fullName.localeCompare(right.fullName, "en-AU", { sensitivity: "base" });
    }

    if (sort === "start") {
      const leftDate = /^\d{4}-\d{2}-\d{2}$/.test(left.startDate) ? left.startDate : "";
      const rightDate = /^\d{4}-\d{2}-\d{2}$/.test(right.startDate) ? right.startDate : "";
      if (leftDate && rightDate && leftDate !== rightDate) return rightDate.localeCompare(leftDate);
      if (leftDate) return -1;
      if (rightDate) return 1;
    } else {
      const leftDue = nextDueDate(left);
      const rightDue = nextDueDate(right);
      if (leftDue && rightDue && leftDue !== rightDue) return leftDue.localeCompare(rightDue);
      if (leftDue) return -1;
      if (rightDue) return 1;
    }

    return left.fullName.localeCompare(right.fullName, "en-AU", { sensitivity: "base" });
  });
}

function listMeta(record: CheckInWorkspaceRecord) {
  const dueDate = nextDueDate(record);
  if (dueDate) return `Due ${formatDate(dueDate)} · ${record.company === "mam" ? "MAM" : "Equipsy"}`;
  return record.positionTitle
    ? `${record.positionTitle} · ${record.company === "mam" ? "MAM" : "Equipsy"}`
    : record.company === "mam" ? "MAM" : "Equipsy";
}

export function CheckInWorkspace({
  onRecordsChanged,
  previewPersonId,
  readOnly = false,
  resources = emptyResources,
}: {
  onRecordsChanged?: () => void;
  previewPersonId?: string;
  readOnly?: boolean;
  resources?: Pick<CheckInResourceLinks, "managerGuideUrl" | "checkInFormUrl" | "probationTemplatesUrl">;
} = {}) {
  const [data, setData] = useState<CheckInWorkspaceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedPersonId, setSelectedPersonId] = useState("");
  const [reviewReminder, setReviewReminder] = useState<CheckInWorkspaceReminder | null>(null);
  const [sort, setSort] = useState<EmployeeSort>("due");
  const [page, setPage] = useState(0);
  const selectedPersonIdRef = useRef("");
  const refreshButtonRef = useRef<HTMLButtonElement>(null);
  const sortRef = useRef<EmployeeSort>("due");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      // This projection is deliberately manager-safe. Its database RPCs
      // enforce the active caller's scope, so direct browser reads remove the
      // otherwise redundant browser → Vercel action → Supabase hop.
      const supabase = createSupabaseClient();
      const { data: raw, error: rpcError } = previewPersonId
        ? await supabase.rpc("list_employee_check_in_workspace_for_preview", { p_person_id: previewPersonId })
        : await supabase.rpc("list_employee_check_in_workspace");
      if (rpcError) {
        throw new Error(rpcError.code === "42501"
          ? "You do not have permission to view check-ins."
          : "Check-ins could not be loaded. Refresh and try again.");
      }
      const next: CheckInWorkspaceData = {
        records: parseCheckInWorkspaceRecords(raw),
        resources,
      };
      const sortedNextRecords = sortRecords(next.records, sortRef.current);
      const preservedPersonId = selectedPersonIdRef.current;
      const nextSelectedPersonId = preservedPersonId && next.records.some((record) => record.personId === preservedPersonId)
        ? preservedPersonId
        : sortedNextRecords[0]?.personId ?? "";
      const selectedIndex = sortedNextRecords.findIndex((record) => record.personId === nextSelectedPersonId);
      setData(next);
      selectedPersonIdRef.current = nextSelectedPersonId;
      setSelectedPersonId(nextSelectedPersonId);
      setPage(selectedIndex >= 0 ? Math.floor(selectedIndex / employeesPerPage) : 0);
    } catch (loadError) {
      setData(null);
      selectedPersonIdRef.current = "";
      setSelectedPersonId("");
      setError(loadError instanceof Error ? loadError.message : "Check-ins could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [previewPersonId, resources]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const sortedRecords = useMemo(() => sortRecords(data?.records ?? [], sort), [data, sort]);
  const selected = useMemo(
    () => sortedRecords.find((record) => record.personId === selectedPersonId) ?? sortedRecords[0] ?? null,
    [selectedPersonId, sortedRecords],
  );
  const pageCount = Math.max(1, Math.ceil(sortedRecords.length / employeesPerPage));
  const currentPage = Math.min(page, pageCount - 1);
  const firstVisibleRecord = currentPage * employeesPerPage + 1;
  const visibleRecords = sortedRecords.slice(currentPage * employeesPerPage, currentPage * employeesPerPage + employeesPerPage);

  function changeSort(value: EmployeeSort) {
    const nextRecords = sortRecords(data?.records ?? [], value);
    const selectedIndex = nextRecords.findIndex((record) => record.personId === selectedPersonIdRef.current);
    sortRef.current = value;
    setSort(value);
    setPage(selectedIndex >= 0 ? Math.floor(selectedIndex / employeesPerPage) : 0);
  }

  function changePage(nextPage: number) {
    const clampedPage = Math.max(0, Math.min(nextPage, pageCount - 1));
    setPage(clampedPage);
    const firstRecord = sortedRecords[clampedPage * employeesPerPage];
    if (firstRecord) selectPerson(firstRecord.personId);
  }

  function selectPerson(personId: string) {
    selectedPersonIdRef.current = personId;
    setSelectedPersonId(personId);
  }

  async function reviewSaved() {
    setNotice("");
    await load();
    onRecordsChanged?.();
    setNotice("Review outcome saved.");
  }

  return <><section className={styles.workspace} aria-label="Employee check-in tasks">
    <h2 className={styles.srOnly}>Employee check-ins</h2>
    <header className={styles.toolbar}>
      {data ? <WorkspaceResources data={data} /> : <span />}
      <button ref={refreshButtonRef} className={styles.secondaryAction} type="button" onClick={() => void load()} disabled={loading} aria-label="Refresh check-ins" title="Refresh">
        <RefreshCw aria-hidden="true" size={16} />
      </button>
    </header>

    {error ? <div className={styles.error} role="alert"><AlertTriangle size={17} /><span>{error}</span></div> : null}
    {notice ? <div className={styles.notice} role="status"><CheckCircle2 size={17} /><span>{notice}</span></div> : null}
    {loading ? <div className={styles.loading}><CalendarClock size={23} /><MotionLoader label="Loading check-ins" /></div> : null}
    {!loading && data && !data.records.length ? <div className={styles.loading}><UsersRound size={23} /><strong>No check-ins</strong></div> : null}

    {!loading && selected && data ? <div className={styles.desk}>
      <aside className={styles.employeeList} aria-label="Employees with visible check-ins">
        <div className={styles.listToolbar}>
          <label htmlFor="check-in-workspace-sort">Sort
            <select id="check-in-workspace-sort" value={sort} onChange={(event) => changeSort(event.target.value as EmployeeSort)}>
              <option value="due">Next due date</option>
              <option value="start">Start date (newest)</option>
              <option value="name">Employee A–Z</option>
            </select>
          </label>
        </div>
        <div className={styles.employeeRows}>
          {visibleRecords.map((record) => {
            const pending = record.reminders.some((reminder) => reminder.status !== "completed");
            return <button
              type="button"
              key={record.personId}
              className={styles.employeeRow}
              data-selected={record.personId === selected.personId}
              data-company={record.company}
              aria-pressed={record.personId === selected.personId}
              onClick={() => selectPerson(record.personId)}
            >
              <span className={styles.avatar}>{initials(record)}</span>
              <span><strong>{record.fullName}</strong><small>{listMeta(record)}</small></span>
              {pending ? <span className={styles.attentionDot} role="status" aria-label="Open check-in" /> : null}
            </button>;
          })}
        </div>
        <nav className={styles.pagination} aria-label="Employee pages">
          <button type="button" onClick={() => changePage(currentPage - 1)} disabled={currentPage === 0} aria-label="Previous employees"><ChevronLeft size={16} /></button>
          <span aria-live="polite">{firstVisibleRecord}–{Math.min(firstVisibleRecord + employeesPerPage - 1, sortedRecords.length)} of {sortedRecords.length}</span>
          <button type="button" onClick={() => changePage(currentPage + 1)} disabled={currentPage >= pageCount - 1} aria-label="Next employees"><ChevronRight size={16} /></button>
        </nav>
      </aside>

      <article className={styles.detail} data-company={selected.company}>
        <header className={styles.personHeader}>
          <div><span className={styles.avatar}>{initials(selected)}</span><span><h3>{selected.fullName}</h3>{selected.positionTitle ? <p>{selected.positionTitle}</p> : null}</span></div>
        </header>

        <div className={`${styles.summaryGrid} ${styles.workspaceSummary}`}>
          <Info label="Start date" value={formatDate(selected.startDate)} />
          <Info label="Company" value={selected.company === "mam" ? "MAM" : "Equipsy"} />
        </div>

        <section className={styles.timeline} aria-label="Check-in milestones">
          <h4 className={styles.srOnly}>Check-ins</h4>
          {!selected.reminders.length ? <p className={styles.emptyTimeline}>No milestones</p> : selected.reminders.map((reminder) => (
            <div className={styles.reminder} data-status={reminder.status} key={reminder.id}>
              <span className={styles.statusDot} />
              <div className={styles.reminderCopy}>
                <strong>{milestoneLabel(reminder.milestone)}{reminder.sequence === "final" ? " · final reminder" : ""}</strong>
                <p>Due {formatDate(reminder.dueDate)}</p>
              </div>
              {reminder.status === "completed" && (!readOnly || reminder.reviewOutcome) ? <button
                className={styles.reviewOutcomeTrigger}
                type="button"
                onClick={() => setReviewReminder(reminder)}
                aria-haspopup="dialog"
                aria-label={`${readOnly ? "View" : reminder.reviewOutcome ? "View or edit" : "Add"} review outcome for ${selected.fullName}, ${milestoneLabel(reminder.milestone)}, due ${formatDate(reminder.dueDate)}`}
              ><AnimatedStatusBadge className={styles.status} tone="success">Completed</AnimatedStatusBadge></button>
                : <AnimatedStatusBadge className={styles.status} tone={reminderTone(reminder.status)}>{reminder.status.replaceAll("_", " ")}</AnimatedStatusBadge>}
              {!readOnly && canCompleteReminder(reminder) ? <div className={styles.reminderActions}>
                <button
                  type="button"
                  onClick={() => setReviewReminder(reminder)}
                  aria-haspopup="dialog"
                  aria-label={`Record review outcome for ${selected.fullName}, ${milestoneLabel(reminder.milestone)}, due ${formatDate(reminder.dueDate)}`}
                >Record outcome</button>
              </div> : null}
            </div>
          ))}
        </section>
      </article>
    </div> : null}
  </section>
  {reviewReminder && selected ? <CheckInReviewOutcomeDialog
    employeeName={selected.fullName}
    milestone={milestoneLabel(reviewReminder.milestone)}
    reminder={reviewReminder}
    readOnly={readOnly}
    returnFocusRef={refreshButtonRef}
    onClose={() => setReviewReminder(null)}
    onSaved={reviewSaved}
  /> : null}</>;
}

function WorkspaceResources({ data }: { data: CheckInWorkspaceData }) {
  const { resources } = data;
  if (!resources.managerGuideUrl && !resources.checkInFormUrl && !resources.probationTemplatesUrl) return null;
  return <section className={styles.resources}>
    <nav aria-label="Check-in resources">
      {resources.managerGuideUrl ? <a href={resources.managerGuideUrl} target="_blank" rel="noreferrer">Manager guide <ExternalLink size={14} /></a> : null}
      {resources.checkInFormUrl ? <a href={resources.checkInFormUrl} target="_blank" rel="noreferrer">Check-in form <ExternalLink size={14} /></a> : null}
      {resources.probationTemplatesUrl ? <a href={resources.probationTemplatesUrl} target="_blank" rel="noreferrer">Probation templates <ExternalLink size={14} /></a> : null}
    </nav>
  </section>;
}

function Info({ label, value }: { label: string; value: string }) {
  return <div className={styles.info}><small>{label}</small><strong>{value}</strong></div>;
}
