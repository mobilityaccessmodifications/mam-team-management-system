"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getTaskNotes, saveTaskNotes } from "@/app/tasks/note-actions";
import type { TaskNotes, TaskNotesTarget } from "@/lib/task-notes-types";
import styles from "@/components/check-in-tasks.module.css";
import toolbar from "@/components/people-toolbar.module.css";
import { MotionLoader } from "@/components/ui/motion-loader";

export type TaskNoteDraft = TaskNotes & { savedText: string };

export function TaskNotesEditor({ target, previewPersonId, readOnly, blocked, drafts, onBusyChange, onActionsBlockedChange }: {
  target: TaskNotesTarget;
  previewPersonId?: string;
  readOnly: boolean;
  blocked: boolean;
  drafts: Map<string, TaskNoteDraft>;
  onBusyChange: (busy: boolean) => void;
  onActionsBlockedChange: (blocked: boolean) => void;
}) {
  const key = `${target.kind}:${target.taskId}:${target.reviewOn ?? ""}`;
  const [draft, setDraft] = useState<TaskNoteDraft>({ text: "", savedText: "", version: 0 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const pending = useRef(false);
  const dirty = draft.text !== draft.savedText;
  const cachedDraft = drafts.get(key);
  const actionsBlocked = loading || dirty || Boolean(cachedDraft && cachedDraft.text !== cachedDraft.savedText);
  const kind = target.kind, taskId = target.taskId, reviewOn = target.reviewOn;

  const load = useCallback(async (discardDraft = false) => {
    const request = ++generation.current;
    setLoading(true);
    setLoadFailed(false);
    setError("");
    setNotice("");
    try {
      const result = await getTaskNotes({ kind, taskId, ...(reviewOn ? { reviewOn } : {}) }, previewPersonId);
      if (request !== generation.current) return;
      if (!result.ok) {
        setLoadFailed(true);
        setDraft({ text: "", savedText: "", version: 0 });
        setError(result.error);
        return;
      }
      const cached = drafts.get(key);
      const next = !discardDraft && cached && cached.text !== cached.savedText
        ? cached : { ...result.notes, savedText: result.notes.text };
      drafts.set(key, next);
      setDraft(next);
      if (next.version !== result.notes.version) setError("Notes have changed. Reload notes before saving your changes.");
    } catch {
      if (request !== generation.current) return;
      setLoadFailed(true);
      setDraft({ text: "", savedText: "", version: 0 });
      setError("Notes could not be loaded. Try again.");
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [drafts, key, kind, previewPersonId, reviewOn, taskId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => { window.clearTimeout(timer); generation.current += 1; };
  }, [load]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  useEffect(() => { onActionsBlockedChange(actionsBlocked); }, [actionsBlocked, onActionsBlockedChange]);
  useEffect(() => () => onActionsBlockedChange(true), [onActionsBlockedChange]);

  async function save() {
    if (readOnly || blocked || previewPersonId || pending.current || loading || !dirty || error) return;
    pending.current = true;
    setSaving(true);
    onBusyChange(true);
    setError("");
    setNotice("");
    const request = generation.current;
    try {
      const result = await saveTaskNotes({ target: { kind, taskId, ...(reviewOn ? { reviewOn } : {}) }, text: draft.text, version: draft.version });
      if (request !== generation.current) return;
      if (!result.ok) { setError(result.error); return; }
      const next = { ...result.notes, savedText: result.notes.text };
      drafts.set(key, next);
      setDraft(next);
      setNotice("Notes saved.");
    } catch {
      if (request === generation.current) setError("Notes could not be saved. Try again.");
    } finally {
      pending.current = false;
      if (request === generation.current) { setSaving(false); onBusyChange(false); }
    }
  }

  return <section className={styles.notes} aria-label="Task notes">
    <label htmlFor={`task-notes-${taskId}`}>Notes</label>
    {loading ? <MotionLoader label="Loading notes" /> : null}
    <textarea id={`task-notes-${taskId}`} value={draft.text} readOnly={readOnly} disabled={blocked || loading || saving || Boolean(error)} rows={6} maxLength={5000} onChange={(event) => {
      if (blocked || loading || saving || readOnly || error) return;
      const next = { ...draft, text: event.target.value };
      drafts.set(key, next);
      setDraft(next);
      setNotice("");
    }} />
    {error ? <div className={styles.noteError} role="alert"><span>{error}</span><button className={toolbar.button} type="button" disabled={blocked || saving} onClick={() => void load(!loadFailed)}>{loadFailed ? "Retry notes" : "Reload notes"}</button></div> : null}
    {notice ? <p className={styles.noteNotice} role="status">{notice}</p> : null}
    {!readOnly ? <div className={styles.noteActions}><button className={toolbar.primary} type="button" disabled={blocked || loading || saving || !dirty || Boolean(error)} aria-busy={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save notes"}</button></div> : null}
  </section>;
}
