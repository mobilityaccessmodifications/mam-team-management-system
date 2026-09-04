"use server";

import {
  decideEmployeeWorkScheduleChange,
  getEmployeeWorkScheduleWorkspace,
  submitEmployeeWorkScheduleChange,
  WorkSchedulePublicError,
} from "@/lib/employee-work-schedule";
import type { EmployeeWorkingWeekday } from "@/lib/employee-directory-types";
import type {
  WorkScheduleLoadResult,
  WorkScheduleMutationResult,
} from "@/lib/work-schedule-types";

const MAX_REASON_LENGTH = 1_000;

function reason(value: unknown) {
  if (typeof value !== "string") return null;
  const next = value.trim();
  return next && next.length <= MAX_REASON_LENGTH ? next : null;
}

function workingWeekdays(value: unknown): EmployeeWorkingWeekday[] | null {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > 7
    || value.some((day) => !Number.isInteger(day) || day < 1 || day > 7)
    || new Set(value).size !== value.length
  ) return null;
  return [...value].sort((first, second) => first - second) as EmployeeWorkingWeekday[];
}

function safeActionMessage(error: unknown, fallback: string) {
  if (!(error instanceof WorkSchedulePublicError)) return fallback;
  const message = error.message.trim();
  return message && message.length <= 220 ? message : fallback;
}

export async function loadEmployeeWorkScheduleWorkspace(
  previewPersonId?: string,
): Promise<WorkScheduleLoadResult> {
  try {
    return {
      ok: true,
      workspace: await getEmployeeWorkScheduleWorkspace(previewPersonId),
    };
  } catch (error) {
    return {
      ok: false,
      kind: error instanceof WorkSchedulePublicError ? error.kind : "data",
      message: safeActionMessage(error, "Work schedule details could not be loaded. Refresh and try again."),
    };
  }
}

export async function requestEmployeeWorkScheduleChange(input: {
  workingWeekdays: unknown;
  reason: unknown;
  previewPersonId?: string;
}): Promise<WorkScheduleMutationResult> {
  const nextDays = workingWeekdays(input.workingWeekdays);
  const nextReason = reason(input.reason);
  if (!nextDays) return { ok: false, message: "Choose at least one work day." };
  if (!nextReason) return { ok: false, message: "Enter a reason of up to 1,000 characters." };

  try {
    await submitEmployeeWorkScheduleChange({
      workingWeekdays: nextDays,
      reason: nextReason,
      previewPersonId: input.previewPersonId,
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: safeActionMessage(error, "The work schedule request could not be saved. Refresh and try again."),
    };
  }
}

export async function reviewEmployeeWorkScheduleChange(input: {
  requestId: unknown;
  decision: unknown;
  reason: unknown;
}): Promise<WorkScheduleMutationResult> {
  const nextReason = reason(input.reason);
  if (typeof input.requestId !== "string" || !input.requestId) {
    return { ok: false, message: "Choose a work schedule request." };
  }
  if (input.decision !== "approved" && input.decision !== "declined") {
    return { ok: false, message: "Choose Approve or Decline." };
  }
  if (!nextReason) return { ok: false, message: "Enter a decision reason of up to 1,000 characters." };

  try {
    await decideEmployeeWorkScheduleChange({
      requestId: input.requestId,
      decision: input.decision,
      reason: nextReason,
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: safeActionMessage(error, "The work schedule request could not be updated. Refresh and try again."),
    };
  }
}
