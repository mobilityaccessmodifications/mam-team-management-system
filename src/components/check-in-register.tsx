"use client";

import {
  AlertTriangle,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  RefreshCw,
  UserRound,
  UsersRound,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  completeCheckInReminder,
} from "@/app/check-ins/actions";
import toolbar from "@/components/people-toolbar.module.css";
import styles from "@/components/check-in-register.module.css";
import { AnimatedStatusBadge } from "@/components/ui/animated-status-badge";
import { MotionLoader } from "@/components/ui/motion-loader";
import {
  CHECK_IN_REGISTER_LOAD_ERROR,
  parseCheckInRegisterRecords,
} from "@/lib/check-in-register-data";
import type {
  CheckInResourceLinks,
  CheckInRegisterData,
  CheckInRegisterRecord,
  CheckInReminder,
} from "@/lib/check-in-register-types";
import { createClient as createSupabaseClient } from "@/lib/supabase/client";

const employeesPerPage = 8;

const emptyResources: CheckInRegisterData["resources"] = {
  managerGuideUrl: null,
  checkInFormUrl: null,
  probationTemplatesUrl: null,
  legacyFormsFolderUrl: null,
  deliveryConfigured: false,
};

type EmployeeSort = "due" | "start" | "name";

function formatDate(value: string) {
  if (!value) return "Not recorded";
  const parsed = new Date(`${value}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(parsed);
}

function milestoneLabel(value: CheckInReminder["milestone"]) {
  if (value === "2_week") return "2-week check-in";
  if (value === "1_month") return "1-month check-in";
  if (value === "2_month") return "2-month stay interview";
  if (value === "3_month") return "3-month check-in";
  return "5-month probation check-in";
}

function canCompleteReminder(reminder: CheckInReminder) {
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

function reminderTone(status: CheckInReminder["status"]): "success" | "warning" | "info" {
  if (status === "completed" || status === "delivered") return "success";
  if (status === "needs_review") return "warning";
  return "info";
}

function reasonLabel(value: string | null) {
  const labels: Record<string, string> = {
    historic_cutover: "Notification date has passed",
    missing_manager_email: "Current manager needs a work email",
    not_enrolled: "Schedule needs review",
    start_date_changed_after_delivery: "Start date changed after a delivery",
    context_changed: "Employee or reporting line changed",
    retry_exhausted: "Delivery retry limit reached",
    missed_delivery: "Scheduled notification date has passed",
  };
  return value ? labels[value] ?? "Needs HR review" : "Needs HR review";
}

function initials(record: CheckInRegisterRecord) {
  return `${record.firstName.slice(0, 1)}${record.lastName.slice(0, 1)}`.toUpperCase() || "–";
}

function nameFor(record: CheckInRegisterRecord) {
  return [record.firstName, record.lastName].filter(Boolean).join(" ") || "Unnamed employee";
}

function nextDueDate(record: Pick<CheckInRegisterRecord, "reminders">) {
  return record.reminders
    .filter((reminder) => reminder.status !== "completed" && /^\d{4}-\d{2}-\d{2}$/.test(reminder.dueDate))
    .map((reminder) => reminder.dueDate)
    .sort()[0] ?? null;
}

function sortRecords(records: CheckInRegisterRecord[], sort: EmployeeSort) {
  return [...records].sort((left, right) => {
    if (sort === "name") {
      return nameFor(left).localeCompare(nameFor(right), "en-AU", { sensitivity: "base" });
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

    return nameFor(left).localeCompare(nameFor(right), "en-AU", { sensitivity: "base" });
  });
}

function listMeta(record: CheckInRegisterRecord) {
  const dueDate = nextDueDate(record);
  if (dueDate) return `Due ${formatDate(dueDate)} · ${record.company === "mam" ? "MAM" : "Equipsy"}`;
  return `${record.role || "Role not recorded"} · ${record.company === "mam" ? "MAM" : "Equipsy"}`;
}

export function CheckInRegister({
  onRecordsChanged,
  resources = emptyResources,
}: {
  onRecordsChanged?: () => void;
  resources?: CheckInResourceLinks;
} = {}) {
  const [data, setData] = useState<CheckInRegisterData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedPersonId, setSelectedPersonId] = useState("");
  const [pendingAction, setPendingAction] = useState("");
  const [notice, setNotice] = useState("");
  const [sort, setSort] = useState<EmployeeSort>("due");
  const [page, setPage] = useState(0);
  const selectedPersonIdRef = useRef("");
  const sortRef = useRef<EmployeeSort>("due");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      // The HR-only database RPC is its own security boundary. Reading this
      // projection directly from the authenticated browser removes a second
      // Vercel round trip without broadening HR data access.
      const supabase = createSupabaseClient();
      const { data: raw, error: rpcError } = await supabase.rpc("list_employee_check_in_register");
      if (rpcError) {
        throw new Error(rpcError.code === "42501"
          ? "You do not have permission to view employee check-ins."
          : CHECK_IN_REGISTER_LOAD_ERROR);
      }
      const next: CheckInRegisterData = {
        records: parseCheckInRegisterRecords(raw),
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
      // This DTO contains HR-private contact data. Do not leave a prior
      // employee record on screen if the renewed session is no longer allowed.
      setData(null);
      selectedPersonIdRef.current = "";
      setSelectedPersonId("");
      setError(loadError instanceof Error ? loadError.message : "Employee check-in records could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [resources]);

  useEffect(() => {
    // Defer the first stateful request beyond effect setup. It also keeps this
    // HR-only component consistent with the project's client data loaders.
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

  function selectPerson(personId: string) {
    selectedPersonIdRef.current = personId;
    setSelectedPersonId(personId);
  }

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

  async function runAction(key: string, task: () => Promise<unknown>, successMessage: string) {
    if (pendingAction) return;
    setPendingAction(key);
    setError("");
    setNotice("");
    try {
      await task();
      await load();
      onRecordsChanged?.();
      setNotice(successMessage);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "The check-in record could not be updated.");
    } finally {
      setPendingAction("");
    }
  }

  return <section className={styles.workspace} aria-label="Employee check-in register">
    <h2 className={styles.srOnly}>Employee check-ins</h2>
    <header className={toolbar.toolbar}>
      <div className={toolbar.controls}>
        <label className={toolbar.select} htmlFor="check-in-register-sort">Sort
          <select id="check-in-register-sort" value={sort} onChange={(event) => changeSort(event.target.value as EmployeeSort)}>
            <option value="due">Next due date</option>
            <option value="start">Start date (newest)</option>
            <option value="name">Employee A–Z</option>
          </select>
        </label>
      </div>

      <button className={toolbar.iconButton} type="button" onClick={() => void load()} disabled={loading || Boolean(pendingAction)} aria-label="Refresh check-ins" title="Refresh">
        <RefreshCw size={16} aria-hidden="true" />
      </button>
    </header>

    {error ? <div className={styles.error} role="alert"><AlertTriangle size={17} /><span>{error}</span></div> : null}
    {notice ? <div className={styles.notice} role="status"><CheckCircle2 size={17} /><span>{notice}</span></div> : null}

    {loading ? <div className={styles.loading}><CalendarClock size={23} /><MotionLoader label="Loading check-ins" /></div> : null}
    {!loading && data && !data.records.length ? <div className={styles.loading}><UsersRound size={23} /><strong>No check-ins</strong></div> : null}

    {!loading && selected && data ? <div className={styles.desk}>
      <aside className={styles.employeeList} aria-label="Employees in check-in register">
        <div className={styles.employeeRows}>
          {visibleRecords.map((record) => {
            const attention = record.reminders.some((reminder) => reminder.status === "needs_review");
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
              <span><strong>{nameFor(record)}</strong><small>{listMeta(record)}</small></span>
              {attention ? <span className={styles.attentionDot} role="status" aria-label="Needs review" /> : null}
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
          <div><span className={styles.avatar}>{initials(selected)}</span><span><h3>{nameFor(selected)}</h3><p>{selected.role || "Role not recorded"}{selected.department ? ` · ${selected.department}` : ""}</p></span></div>
          {selected.enrolmentMode === "needs_review" ? <span className={styles.enrolment} data-mode="needs_review">Review required</span> : null}
        </header>

        <div className={styles.summaryGrid}>
          <Info label="Manager" value={selected.managerName || "Not assigned"} />
          <Info label="Reminder recipient" value={selected.recipientEmail || "Not recorded"} valueKind="email" warning={selected.recipientSource === "missing"} />
          <Info label="Start date" value={formatDate(selected.startDate)} />
          <Info label="Company" value={selected.company === "mam" ? "MAM" : "Equipsy"} />
        </div>

        <details className={styles.privateDetails}>
          <summary><UserRound size={16} aria-hidden="true" /><span>Contact details</span></summary>
          <div>
            <Info label="Address" value={selected.address || "Not recorded"} />
            <Info label="Date of birth" value={formatDate(selected.dateOfBirth)} />
            <Info label="Mobile" value={selected.mobile || "Not recorded"} />
            <Info label="Employee email" value={selected.email || "Not recorded"} />
          </div>
        </details>

        <section className={styles.timeline} aria-label="Check-in milestones">
          <h4 className={styles.srOnly}>Check-ins</h4>
          {!selected.reminders.length ? <p className={styles.emptyTimeline}>No milestones</p> : selected.reminders.map((reminder) => <ReminderRow
            key={reminder.id}
            reminder={reminder}
            pending={pendingAction}
            onComplete={() => void runAction(`complete:${reminder.id}`, () => completeCheckInReminder(reminder.id), "The check-in has been marked complete.")}
          />)}
        </section>
      </article>
    </div> : null}
  </section>;
}

function ReminderRow({ reminder, pending, onComplete }: {
  reminder: CheckInReminder;
  pending: string;
  onComplete: () => void;
}) {
  const isPending = Boolean(pending);
  return <div className={styles.reminder} data-status={reminder.status}>
    <div className={styles.reminderCopy}><strong>{milestoneLabel(reminder.milestone)}{reminder.sequence === "final" ? " · final reminder" : ""}</strong><p>{formatDate(reminder.dueDate)}</p>{reminder.status === "needs_review" ? <small>{reasonLabel(reminder.needsReviewReason)}</small> : null}</div>
    <AnimatedStatusBadge className={styles.status} tone={reminderTone(reminder.status)}>{reminder.status.replaceAll("_", " ")}</AnimatedStatusBadge>
    <div className={styles.reminderActions}>
      {canCompleteReminder(reminder) ? <button type="button" disabled={isPending} onClick={onComplete}>{pending === `complete:${reminder.id}` ? "Saving…" : "Mark complete"}</button> : null}
    </div>
  </div>;
}

function Info({
  label,
  value,
  warning = false,
  valueKind = "text",
}: {
  label: string;
  value: string;
  warning?: boolean;
  valueKind?: "text" | "email";
}) {
  return <div className={styles.info} data-warning={warning} data-value-kind={valueKind}>
    <small>{label}</small>
    <strong title={valueKind === "email" ? value : undefined}>{value}</strong>
  </div>;
}
