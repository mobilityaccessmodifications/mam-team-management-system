"use client";

import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { completeMySubscriptionPasswordTask } from "@/app/subscriptions/password-task-actions";
import { createClient } from "@/lib/supabase/client";
import { parseSubscriptionPasswordTasks, SUBSCRIPTION_PASSWORD_LOAD_ERROR, type SubscriptionPasswordTask } from "@/lib/subscription-password-tasks";

export function useSubscriptionPasswordTasks({ previewPersonId, readOnly = false, enabled = true }: { previewPersonId?: string; readOnly?: boolean; enabled?: boolean }) {
  const [tasks, setTasks] = useState<SubscriptionPasswordTask[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingId, setPendingId] = useState("");
  const pending = useRef(false);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true); setError(""); setNotice("");
    if (!enabled) { setTasks([]); setLoading(false); return; }
    try {
      const supabase = createClient();
      const { data, error: failure } = previewPersonId
        ? await supabase.rpc("list_subscription_password_tasks_for_preview", { p_person_id: previewPersonId })
        : await supabase.rpc("list_my_subscription_password_tasks");
      if (failure) throw new Error(SUBSCRIPTION_PASSWORD_LOAD_ERROR);
      const result = parseSubscriptionPasswordTasks(data);
      if (request === generation.current) setTasks(result);
    } catch {
      if (request === generation.current) { setTasks([]); setError(SUBSCRIPTION_PASSWORD_LOAD_ERROR); }
    } finally { if (request === generation.current) setLoading(false); }
  }, [enabled, previewPersonId]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => { window.clearTimeout(timer); generation.current += 1; };
  }, [load]);

  function complete(task: SubscriptionPasswordTask) {
    if (readOnly || previewPersonId || pending.current) return;
    pending.current = true; setPendingId(task.taskId); setError(""); setNotice("");
    const request = generation.current;
    startTransition(async () => {
      try {
        const result = await completeMySubscriptionPasswordTask({ taskId: task.taskId, version: task.version, passwordChanged: true });
        if (request !== generation.current) return;
        if (!result.ok) { setError(result.error); return; }
        setTasks((previous) => previous.filter((value) => value.taskId !== task.taskId));
        setNotice(result.warning ?? `${task.serviceName}'s password change is recorded.`);
      } catch {
        if (request === generation.current) setError("The password change could not be recorded. Refresh and try again.");
      } finally { pending.current = false; if (request === generation.current) setPendingId(""); }
    });
  }
  return { tasks, loading, error, notice, pendingId, load, complete };
}
