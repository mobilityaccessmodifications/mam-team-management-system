"use server";

import { createClient } from "@/lib/supabase/server";
import { MAX_TASK_NOTES_LENGTH, type TaskNotes, type TaskNotesTarget } from "@/lib/task-notes-types";

type TaskNotesResult = { ok: true; notes: TaskNotes } | { ok: false; error: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOAD_ERROR = "Task notes could not be loaded. Refresh and try again.";
const SAVE_ERROR = "Task notes could not be saved. Refresh and try again.";

function validTarget(target: unknown): target is TaskNotesTarget {
  if (!target || typeof target !== "object" || Array.isArray(target)) return false;
  const value = target as TaskNotesTarget;
  if (typeof value.taskId !== "string" || !UUID.test(value.taskId)) return false;
  if (value.kind === "check_in" || value.kind === "work_schedule") return value.reviewOn === undefined;
  if (value.kind !== "subscription_review" || typeof value.reviewOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.reviewOn)) return false;
  const date = new Date(`${value.reviewOn}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value.reviewOn;
}

function parseNotes(data: unknown): TaskNotes | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as TaskNotes;
  if (typeof value.text !== "string" || value.text.length > MAX_TASK_NOTES_LENGTH || value.text.includes("\0")
    || !Number.isSafeInteger(value.version) || value.version < 0) return null;
  return { text: value.text, version: value.version };
}

function safeError(code: string | undefined, fallback: string) {
  if (code === "40001") return "These notes have changed. Refresh them, then try again.";
  if (code === "42501") return "You do not have permission to access notes for this task.";
  if (code === "22023") return "This task has changed. Refresh it, then try again.";
  return fallback;
}

export async function getTaskNotes(target: TaskNotesTarget, previewPersonId?: string): Promise<TaskNotesResult> {
  if (!validTarget(target) || (previewPersonId !== undefined && (typeof previewPersonId !== "string" || !UUID.test(previewPersonId)))) {
    return { ok: false, error: LOAD_ERROR };
  }
  try {
    const supabase = await createClient();
    const { data: auth, error: authError } = await supabase.auth.getUser();
    if (authError || !auth.user) return { ok: false, error: "Your session has expired. Sign in again." };
    const { data, error } = await supabase.rpc("get_visible_task_notes", {
      p_kind: target.kind, p_task_id: target.taskId, p_review_on: target.reviewOn ?? null,
      p_preview_person_id: previewPersonId ?? null,
    });
    if (error) return { ok: false, error: safeError(error.code, LOAD_ERROR) };
    const notes = parseNotes(data);
    return notes ? { ok: true, notes } : { ok: false, error: LOAD_ERROR };
  } catch {
    return { ok: false, error: LOAD_ERROR };
  }
}

export async function saveTaskNotes(input: {
  target: TaskNotesTarget;
  text: string;
  version: number;
  previewPersonId?: string;
}): Promise<TaskNotesResult> {
  if (!input || input.previewPersonId !== undefined) return { ok: false, error: "Change profile is read-only for task notes." };
  if (!validTarget(input.target) || typeof input.text !== "string" || input.text.length > MAX_TASK_NOTES_LENGTH || input.text.includes("\0")
    || !Number.isSafeInteger(input.version) || input.version < 0 || input.version >= Number.MAX_SAFE_INTEGER) {
    return { ok: false, error: "Enter task notes of up to 5,000 characters and refresh before saving." };
  }
  try {
    const supabase = await createClient();
    const { data: auth, error: authError } = await supabase.auth.getUser();
    if (authError || !auth.user) return { ok: false, error: "Your session has expired. Sign in again." };
    const { data, error } = await supabase.rpc("save_visible_task_notes", {
      p_kind: input.target.kind, p_task_id: input.target.taskId, p_review_on: input.target.reviewOn ?? null,
      p_text: input.text, p_expected_version: input.version,
    });
    if (error) return { ok: false, error: safeError(error.code, SAVE_ERROR) };
    const notes = parseNotes(data);
    if (!notes || notes.version !== input.version + 1 || notes.text !== input.text) {
      return { ok: true, notes: { text: input.text, version: input.version + 1 } };
    }
    return { ok: true, notes };
  } catch {
    return { ok: false, error: SAVE_ERROR };
  }
}
