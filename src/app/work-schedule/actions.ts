"use server";

import {
  decideEmployeeWorkScheduleChange,
  getEmployeeWorkScheduleWorkspace,
  submitEmployeeWorkScheduleChange,
  WorkSchedulePublicError,
} from "@/lib/employee-work-schedule";
import type {
  EmployeeWorkingDayTime,
  EmployeeWorkingWeekday,
} from "@/lib/employee-directory-types";
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

function optionalReason(value: unknown) {
  if (typeof value !== "string") return null;
  const next = value.trim();
  return next.length <= MAX_REASON_LENGTH ? next : null;
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

function workingDayTimes(
  value: unknown,
  selectedWeekdays: EmployeeWorkingWeekday[],
): EmployeeWorkingDayTime[] | null {
  if (!Array.isArray(value) || value.length > 7) return null;
  const selected = new Set(selectedWeekdays);
  const seen = new Set<number>();
  const timePattern = /^(?:[01]\d|2[0-3]):(?:00|15|30|45)$/;
  const result: EmployeeWorkingDayTime[] = [];

  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const row = candidate as Record<string, unknown>;
    if (
      !Number.isInteger(row.weekday)
      || Number(row.weekday) < 1
      || Number(row.weekday) > 7
      || !selected.has(Number(row.weekday) as EmployeeWorkingWeekday)
      || seen.has(Number(row.weekday))
      || typeof row.startTime !== "string"
      || typeof row.endTime !== "string"
      || !timePattern.test(row.startTime)
      || !timePattern.test(row.endTime)
      || row.endTime <= row.startTime
    ) return null;
    seen.add(Number(row.weekday));
    result.push({
      weekday: Number(row.weekday) as EmployeeWorkingWeekday,
      startTime: row.startTime,
      endTime: row.endTime,
    });
  }

  return result.sort((first, second) => first.weekday - second.weekday);
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
  workingDayTimes: unknown;
  reason: unknown;
  previewPersonId?: string;
}): Promise<WorkScheduleMutationResult> {
  const nextDays = workingWeekdays(input.workingWeekdays);
  const nextReason = optionalReason(input.reason);
  if (!nextDays) return { ok: false, message: "Choose at least one work day." };
  const nextTimes = workingDayTimes(input.workingDayTimes, nextDays);
  if (!nextTimes) return { ok: false, message: "Choose valid start and finish times in 15-minute intervals." };
  if (nextReason === null) return { ok: false, message: "Enter a reason of up to 1,000 characters." };

  try {
    const outcome = await submitEmployeeWorkScheduleChange({
      workingWeekdays: nextDays,
      workingDayTimes: nextTimes,
      reason: nextReason,
      previewPersonId: input.previewPersonId,
    });
    return { ok: true, outcome };
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
