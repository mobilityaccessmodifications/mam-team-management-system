"use client";

import { AlertTriangle, CheckCircle2, RotateCcw } from "lucide-react";
import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { completeMySubscriptionReviewTask } from "@/app/subscriptions/review-task-actions";
import styles from "@/components/check-in-tasks.module.css";
import { MotionLoader } from "@/components/ui/motion-loader";
import { createClient } from "@/lib/supabase/client";
import { parseSubscriptionReviewTasks, SUBSCRIPTION_REVIEW_LOAD_ERROR, type SubscriptionReviewTask } from "@/lib/subscription-review-tasks";

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Melbourne", day: "numeric", month: "short", year: "numeric" }).format(new Date(`${value}T12:00:00Z`));
}

export function useSubscriptionReviewTasks({ previewPersonId, readOnly = false, enabled = true }: { previewPersonId?: string; readOnly?: boolean; enabled?: boolean }) {
  const [tasks, setTasks] = useState<SubscriptionReviewTask[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingId, setPendingId] = useState("");
  const pending = useRef(false);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    setError("");
    setNotice("");
    if (!enabled) { setTasks([]); setLoading(false); return; }
    try {
      const supabase = createClient();
      const { data, error: failure } = previewPersonId
        ? await supabase.rpc("list_subscription_review_tasks_for_preview", { p_person_id: previewPersonId })
        : await supabase.rpc("list_my_subscription_review_tasks");
      if (failure) throw new Error(SUBSCRIPTION_REVIEW_LOAD_ERROR);
      const result = parseSubscriptionReviewTasks(data);
      if (request === generation.current) setTasks(result);
    } catch {
      if (request === generation.current) {
        setTasks([]);
        setError(SUBSCRIPTION_REVIEW_LOAD_ERROR);
      }
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [enabled, previewPersonId]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => { window.clearTimeout(timer); generation.current += 1; };
  }, [load]);

  function complete(task: SubscriptionReviewTask) {
    if (readOnly || previewPersonId || pending.current || !task.canComplete) return;
    pending.current = true;
    setPendingId(task.subscriptionId);
    setError("");
    setNotice("");
    const request = generation.current;
    startTransition(async () => {
      try {
        const result = await completeMySubscriptionReviewTask({ subscriptionId: task.subscriptionId, version: task.version });
        if (request !== generation.current) return;
        if (!result.ok) { setError(result.error); return; }
        setTasks((previous) => result.task
          ? previous.map((value) => value.subscriptionId === task.subscriptionId ? result.task! : value)
          : previous.filter((value) => value.subscriptionId !== task.subscriptionId));
        setNotice(result.warning ?? `${task.serviceName}'s review is complete.`);
      } catch {
        if (request === generation.current) setError("The subscription review could not be recorded. Refresh and try again.");
      } finally {
        pending.current = false;
        if (request === generation.current) setPendingId("");
      }
    });
  }

  return { tasks, loading, error, notice, pendingId, load, complete };
}

export function SubscriptionReviewTasks({ previewPersonId, readOnly = false }: { previewPersonId?: string; readOnly?: boolean }) {
  const { tasks, loading, error, notice, pendingId, load, complete } = useSubscriptionReviewTasks({ previewPersonId, readOnly });

  return <section className={styles.workspace} aria-label="Subscription review tasks">
    <div className={styles.header}>
      <h3>Subscription reviews</h3>
      <button className={styles.refresh} type="button" aria-label="Refresh subscription review tasks" disabled={loading || Boolean(pendingId)} onClick={() => void load()}><RotateCcw size={18} aria-hidden="true" /></button>
    </div>
    {error ? <p className={styles.error} role="alert"><AlertTriangle size={17} aria-hidden="true" />{error}</p> : null}
    {notice ? <p className={styles.notice} role="status"><CheckCircle2 size={17} aria-hidden="true" />{notice}</p> : null}
    {loading ? <div className={styles.loading}><MotionLoader label="Loading subscription review tasks" /></div> : null}
    {!loading && !error && !tasks.length ? <div className={styles.empty}><strong>No subscription reviews need your action.</strong></div> : null}
    {!loading && tasks.length ? <div className={styles.list}>{tasks.map((task) => <article className={styles.task} key={task.subscriptionId}>
      <div className={styles.person}><strong>{task.serviceName}</strong></div>
      <div className={styles.milestone}><strong>Quarterly subscription review</strong><span>Due {formatDate(task.nextReviewOn)}</span></div>
      <span className={styles.status}>{task.status === "paused" ? "Paused" : "Active"}</span>
      {!readOnly && !previewPersonId ? <button className={`${styles.complete} ${styles.reviewDone}`} type="button" disabled={Boolean(pendingId) || !task.canComplete} aria-busy={pendingId === task.subscriptionId} aria-label={`Mark ${task.serviceName}'s subscription review done`} onClick={() => complete(task)}><CheckCircle2 size={19} aria-hidden="true" /><span>Done</span></button> : null}
    </article>)}</div> : null}
  </section>;
}
