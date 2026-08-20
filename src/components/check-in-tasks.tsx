"use client";

import {
  AlertTriangle,
  CalendarCheck2,
  CheckCircle2,
  CircleAlert,
  RefreshCw,
  UsersRound,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  completeMyEmployeeCheckInTask,
  getEmployeeCheckInTasksForPreview,
  getMyEmployeeCheckInTasks,
} from "@/app/check-in-tasks/actions";
import styles from "@/components/check-in-tasks.module.css";
import type { CheckInTask, CheckInTasksData } from "@/lib/check-in-tasks-types";

function formatDate(value: string) {
  const parsed = new Date(`${value}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(parsed);
}

function milestoneLabel(value: CheckInTask["milestone"]) {
  if (value === "2_week") return "2-week check-in";
  if (value === "1_month") return "1-month check-in";
  if (value === "3_month") return "3-month check-in";
  return "5-month probation check-in";
}

function statusLabel(value: CheckInTask["status"]) {
  if (value === "scheduled") return "Scheduled";
  if (value === "claimed") return "Sending reminder";
  if (value === "delivered") return "Ready";
  return "Needs review";
}

function companyLabel(value: CheckInTask["company"]) {
  return value === "mam" ? "MAM" : "Equipsy";
}

function taskActionHint(task: CheckInTask) {
  if (task.canComplete) return "Mark this check-in complete";
  if (task.status === "claimed") return "This reminder is currently being sent.";
  return "This check-in can be completed on or after its due date.";
}

/**
 * Current-user-scoped manager task list. It has no HR register fields and the
 * Server Actions/database RPCs independently re-check each caller’s scope.
 */
export function CheckInTasks({ previewPersonId, readOnly = false }: { previewPersonId?: string; readOnly?: boolean } = {}) {
  const [data, setData] = useState<CheckInTasksData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingReminderId, setPendingReminderId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = previewPersonId
        ? await getEmployeeCheckInTasksForPreview(previewPersonId)
        : await getMyEmployeeCheckInTasks();
      setData(next);
    } catch (loadError) {
      // Do not retain an earlier scoped result when an active session, grant,
      // or hierarchy check is no longer valid.
      setData(null);
      setError(loadError instanceof Error ? loadError.message : "Check-in tasks could not be loaded. Refresh and try again.");
    } finally {
      setLoading(false);
    }
  }, [previewPersonId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function completeTask(task: CheckInTask) {
    if (readOnly || pendingReminderId || !task.canComplete) return;
    setPendingReminderId(task.reminderId);
    setError("");
    setNotice("");
    try {
      await completeMyEmployeeCheckInTask(task.reminderId);
      await load();
      setNotice(`${task.employeeName}'s check-in is complete.`);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "The check-in task could not be marked complete. Refresh and try again.");
    } finally {
      setPendingReminderId("");
    }
  }

  return <section className={styles.workspace} aria-label="Check-in tasks">
    <header className={styles.header}>
      <h2>Check-in tasks</h2>
      <button
        className={styles.refresh}
        type="button"
        onClick={() => void load()}
        disabled={loading || Boolean(pendingReminderId)}
      >
        <RefreshCw size={16} aria-hidden="true" />
        Refresh
      </button>
    </header>

    {error ? <p className={styles.error} role="alert"><AlertTriangle size={17} aria-hidden="true" />{error}</p> : null}
    {notice ? <p className={styles.notice} role="status"><CheckCircle2 size={17} aria-hidden="true" />{notice}</p> : null}

    {loading ? <div className={styles.loading} aria-live="polite"><CalendarCheck2 size={24} aria-hidden="true" /><strong>Loading check-in tasks…</strong></div> : null}
    {!loading && data && !data.tasks.length ? <div className={styles.empty}>
      <UsersRound size={24} aria-hidden="true" />
      <strong>No check-ins need your action.</strong>
    </div> : null}
    {!loading && data?.tasks.length ? <div className={styles.list}>
      {data.tasks.map((task) => {
        const pending = pendingReminderId === task.reminderId;
        return <article className={styles.task} key={task.reminderId}>
          <div className={styles.person}>
            <strong>{task.employeeName}</strong>
            <span>{task.positionTitle || "Role not recorded"} · {companyLabel(task.company)}</span>
          </div>
          <div className={styles.milestone}>
            <strong>{milestoneLabel(task.milestone)}</strong>
            <span>Due {formatDate(task.dueDate)}</span>
          </div>
          <span className={styles.status} data-status={task.status}>
            {task.status === "needs_review" ? <CircleAlert size={14} aria-hidden="true" /> : null}
            {statusLabel(task.status)}
          </span>
          {!readOnly ? <button
              className={styles.complete}
              type="button"
              disabled={Boolean(pendingReminderId) || !task.canComplete}
              onClick={() => void completeTask(task)}
              title={taskActionHint(task)}
            >
              <CheckCircle2 size={16} aria-hidden="true" />
              {pending ? "Saving…" : "Mark complete"}
            </button> : null}
        </article>;
      })}
    </div> : null}
  </section>;
}
