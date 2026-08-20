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

import {
  completeVisibleCheckInReminder,
  getCheckInWorkspace,
} from "@/app/check-ins/actions";
import styles from "@/components/check-in-register.module.css";
import type {
  CheckInWorkspaceData,
  CheckInWorkspaceRecord,
  CheckInWorkspaceReminder,
} from "@/lib/check-in-register-types";

const employeesPerPage = 8;

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
  if (value === "3_month") return "3-month check-in";
  return "5-month probation check-in";
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
  return reminder.status !== "completed" && /^\d{4}-\d{2}-\d{2}$/.test(reminder.dueDate) && reminder.dueDate <= today;
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
  return `${record.positionTitle || "Role not recorded"} · ${record.company === "mam" ? "MAM" : "Equipsy"}`;
}

export function CheckInWorkspace({ onRecordsChanged }: { onRecordsChanged?: () => void } = {}) {
  const [data, setData] = useState<CheckInWorkspaceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedPersonId, setSelectedPersonId] = useState("");
  const [pendingReminderId, setPendingReminderId] = useState("");
  const [sort, setSort] = useState<EmployeeSort>("due");
  const [page, setPage] = useState(0);
  const selectedPersonIdRef = useRef("");
  const sortRef = useRef<EmployeeSort>("due");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await getCheckInWorkspace();
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
  }, []);

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

  async function markComplete(reminderId: string) {
    if (pendingReminderId) return;
    setPendingReminderId(reminderId);
    setError("");
    setNotice("");
    try {
      await completeVisibleCheckInReminder(reminderId);
      await load();
      onRecordsChanged?.();
      setNotice("Check-in marked complete.");
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "The check-in could not be updated.");
    } finally {
      setPendingReminderId("");
    }
  }

  return <section className={styles.workspace} aria-label="Employee check-in tasks">
    <h2 className={styles.srOnly}>Employee check-ins</h2>
    <header className={styles.toolbar}>
      {data ? <WorkspaceResources data={data} /> : <span />}
      <button className={styles.secondaryAction} type="button" onClick={() => void load()} disabled={loading || Boolean(pendingReminderId)}>
        <RefreshCw size={16} /> Refresh
      </button>
    </header>

    {error ? <div className={styles.error} role="alert"><AlertTriangle size={17} /><span>{error}</span></div> : null}
    {notice ? <div className={styles.notice} role="status"><CheckCircle2 size={17} /><span>{notice}</span></div> : null}
    {loading ? <div className={styles.loading}><CalendarClock size={23} /><strong>Loading check-ins…</strong></div> : null}
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

      <article className={styles.detail}>
        <header className={styles.personHeader}>
          <div><span className={styles.avatar}>{initials(selected)}</span><span><h3>{selected.fullName}</h3><p>{selected.positionTitle || "Role not recorded"}</p></span></div>
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
              <span className={styles.status}>{reminder.status.replaceAll("_", " ")}</span>
              {canCompleteReminder(reminder) ? <div className={styles.reminderActions}>
                <button type="button" disabled={Boolean(pendingReminderId)} onClick={() => void markComplete(reminder.id)}>
                  {pendingReminderId === reminder.id ? "Saving…" : "Mark complete"}
                </button>
              </div> : null}
            </div>
          ))}
        </section>
      </article>
    </div> : null}
  </section>;
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
