"use client";

import {
  AlertTriangle,
  CalendarCheck2,
  CheckCircle2,
  CircleAlert,
  UsersRound,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import {
  completeMyEmployeeCheckInTask,
} from "@/app/check-in-tasks/actions";
import styles from "@/components/check-in-tasks.module.css";
import {
  CHECK_IN_TASK_LOAD_ERROR,
  parseCheckInTasks,
} from "@/lib/check-in-tasks-data";
import type { CheckInTask, CheckInTasksData } from "@/lib/check-in-tasks-types";
import { createClient as createSupabaseClient } from "@/lib/supabase/client";
import { MotionLoader } from "@/components/ui/motion-loader";

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
  if (value === "2_month") return "2-month stay interview";
  if (value === "3_month") return "3-month check-in";
  if (value === "6_month_casual") return "6-month casual check-in";
  if (value === "6_month") return "6-month check-in";
  return "5-Month No-Surprises Review";
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

/**
 * Current-user-scoped manager task list. It has no HR register fields and the
 * Server Actions/database RPCs independently re-check each caller’s scope.
 */
export function CheckInTasks({
  previewPersonId,
  readOnly = false,
  toolbarAction,
  scheduleContent,
  showCheckInTasks = true,
}: {
  previewPersonId?: string;
  readOnly?: boolean;
  toolbarAction?: ReactNode;
  scheduleContent?: ReactNode;
  showCheckInTasks?: boolean;
} = {}) {
  const [data, setData] = useState<CheckInTasksData | null>(null);
  const [loading, setLoading] = useState(showCheckInTasks);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingReminderId, setPendingReminderId] = useState("");
  const [reviewReminderId, setReviewReminderId] = useState("");

  const load = useCallback(async () => {
    if (!showCheckInTasks) {
      setData(null);
      setError("");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      // These RPCs already enforce the active caller's database scope. Calling
      // them from the authenticated browser removes an otherwise unnecessary
      // browser → Vercel Action → Supabase round trip on every tab open.
      const supabase = createSupabaseClient();
      const { data: raw, error: rpcError } = previewPersonId
        ? await supabase.rpc("list_employee_check_in_tasks_for_preview", { p_person_id: previewPersonId })
        : await supabase.rpc("list_my_employee_check_in_tasks");
      if (rpcError) {
        throw new Error(rpcError.code === "42501"
          ? "You do not have permission to view check-in tasks."
          : CHECK_IN_TASK_LOAD_ERROR);
      }
      setData(parseCheckInTasks(raw));
    } catch (loadError) {
      // Do not retain an earlier scoped result when an active session, grant,
      // or hierarchy check is no longer valid.
      setData(null);
      setError(loadError instanceof Error ? loadError.message : "Check-in tasks could not be loaded. Refresh and try again.");
    } finally {
      setLoading(false);
    }
  }, [previewPersonId, showCheckInTasks]);

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

  return <section className={styles.workspace} aria-label={showCheckInTasks ? "Check-in tasks" : "Work schedule"}>
    {toolbarAction ? <div className={styles.headerActions}>{toolbarAction}</div> : null}

    {scheduleContent}

    {showCheckInTasks && error ? <p className={styles.error} role="alert"><AlertTriangle size={17} aria-hidden="true" />{error}</p> : null}
    {showCheckInTasks && notice ? <p className={styles.notice} role="status"><CheckCircle2 size={17} aria-hidden="true" />{notice}</p> : null}

    {showCheckInTasks && loading ? <div className={styles.loading} aria-live="polite"><CalendarCheck2 size={24} aria-hidden="true" /><MotionLoader label="Loading check-in tasks" /></div> : null}
    {showCheckInTasks && !loading && data && !data.tasks.length ? <div className={styles.empty}>
      <UsersRound size={24} aria-hidden="true" />
      <strong>No check-ins need your action.</strong>
    </div> : null}
    {showCheckInTasks && !loading && data?.tasks.length ? <div className={styles.list}>
      {data.tasks.map((task) => {
        const pending = pendingReminderId === task.reminderId;
        const reviewOpen = reviewReminderId === task.reminderId;
        const reviewCopy = reviewReasonCopyFor(task);
        return <article className={styles.task} data-status={task.status} key={task.reminderId}>
          <div className={styles.person}>
            <strong>{task.employeeName}</strong>
            <span>{task.positionTitle || "Role not recorded"} · {companyLabel(task.company)}</span>
          </div>
          <div className={styles.milestone}>
            <strong>{milestoneLabel(task.milestone)}</strong>
            <span>Due {formatDate(task.dueDate)}</span>
          </div>
          {task.status === "needs_review" ? <button
            className={`${styles.status} ${styles.statusButton}`}
            data-status={task.status}
            type="button"
            aria-label={`${reviewOpen ? "Hide" : "Show"} why ${task.employeeName}'s ${milestoneLabel(task.milestone)} needs review`}
            aria-expanded={reviewOpen}
            aria-controls={`review-${task.reminderId}`}
            title="Needs review"
            onClick={() => setReviewReminderId(reviewOpen ? "" : task.reminderId)}
          >
            <CircleAlert size={18} aria-hidden="true" />
            <span className={styles.touchLabel}>Needs review</span>
          </button> : task.status !== "scheduled" ? <span className={styles.status} data-status={task.status}>{statusLabel(task.status)}</span> : null}
          {!readOnly ? <button
              className={styles.complete}
              type="button"
              disabled={Boolean(pendingReminderId) || !task.canComplete}
              onClick={() => void completeTask(task)}
              aria-label={pending
                ? `Marking ${task.employeeName}'s ${milestoneLabel(task.milestone)} complete`
                : `Mark ${task.employeeName}'s ${milestoneLabel(task.milestone)} complete`}
              aria-busy={pending}
              title={taskActionHint(task)}
            >
              <CheckCircle2 size={19} aria-hidden="true" />
              <span className={styles.touchLabel}>Complete</span>
            </button> : null}
          {reviewOpen ? <div className={styles.reviewPanel} id={`review-${task.reminderId}`} role="region" aria-label={`Why ${task.employeeName}'s check-in needs review`}>
            <strong>{reviewCopy.title}</strong>
            <p>{reviewCopy.detail}</p>
            <small>{reviewCopy.nextStep}</small>
          </div> : null}
        </article>;
      })}
    </div> : null}
  </section>;
}
