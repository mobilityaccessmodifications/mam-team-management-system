"use server";

import { revalidatePath } from "next/cache";

import {
  findManagedEmployeeDirectoryRecord,
  isManagedDirectoryUuid,
  listManagedEmployeeDirectoryRecords,
  requireManagedEmployeeDirectoryManager,
  requireManagedEmployeeDirectoryPreview,
} from "@/lib/manager-employee-directory";
import type {
  ManagedEmployeeDirectoryMutationResult,
  ManagedEmployeeDirectoryRecord,
  UpdateManagedEmployeeDirectoryInput,
} from "@/lib/employee-directory-types";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;
const GENERIC_SAVE_ERROR = "This employee record could not be saved. Refresh and try again.";
const GENERIC_LIST_ERROR = "Team employee records could not be loaded. Refresh and try again.";

type MutationRpcRow = {
  person_id: string;
};

export type ManagedEmployeeDirectoryListResult =
  | { ok: true; records: ManagedEmployeeDirectoryRecord[] }
  | { ok: false; message: string };

function inputObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(GENERIC_SAVE_ERROR);
  }
  return value as Record<string, unknown>;
}

function textValue(value: unknown, label: string) {
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  return value;
}

function requiredText(value: unknown, label: string, maximum: number) {
  const cleaned = textValue(value, label).trim();
  if (!cleaned || cleaned.length > maximum) {
    throw new Error(`${label} is required and must be ${maximum} characters or fewer.`);
  }
  return cleaned;
}

function optionalText(value: unknown, label: string, maximum: number) {
  const cleaned = textValue(value, label).trim();
  if (cleaned.length > maximum) {
    throw new Error(`${label} must be ${maximum} characters or fewer.`);
  }
  return cleaned;
}

function optionalEmail(value: unknown) {
  const cleaned = optionalText(value, "Work email", 254);
  if (cleaned && !EMAIL_PATTERN.test(cleaned)) {
    throw new Error("Enter a valid work email address.");
  }
  return cleaned;
}

function version(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(GENERIC_SAVE_ERROR);
  }
  return value;
}

function previewManagerPersonId(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  if (!isManagedDirectoryUuid(value)) throw new Error(GENERIC_SAVE_ERROR);
  return value;
}

function values(input: Record<string, unknown>) {
  if (!isManagedDirectoryUuid(input.personId)) throw new Error(GENERIC_SAVE_ERROR);

  return {
    p_person_id: input.personId,
    p_first_name: requiredText(input.firstName, "First name", 80),
    p_last_name: optionalText(input.lastName, "Last name", 120),
    p_work_email: optionalEmail(input.workEmail),
    p_position_title: requiredText(input.positionTitle, "Job title", 120),
    p_team_name: optionalText(input.teamName, "Team", 120),
    p_expected_person_version: version(input.personVersion),
    p_expected_detail_version: version(input.detailVersion),
  };
}

function returnedPersonId(data: unknown) {
  const row = (Array.isArray(data) ? data[0] : null) as MutationRpcRow | undefined;
  if (!row || !isManagedDirectoryUuid(row.person_id)) throw new Error(GENERIC_SAVE_ERROR);
  return row.person_id;
}

function mutationError(error: { message?: string } | null) {
  const message = error?.message?.toLocaleLowerCase() ?? "";
  if (message.includes("version") || message.includes("changed")) {
    return new Error("This record has changed. Refresh it, then try again.");
  }
  if (message.includes("scope") || message.includes("permission") || message.includes("manager")) {
    return new Error("You do not have permission to update this employee.");
  }
  return new Error(GENERIC_SAVE_ERROR);
}

/**
 * Returns only active direct/indirect reports for the signed-in manager, or
 * the selected manager's exact scope while a System Admin uses Change profile.
 */
export async function listManagedEmployeeDirectoryRecordsAction(
  previewManagerPersonIdValue?: string,
): Promise<ManagedEmployeeDirectoryListResult> {
  try {
    return {
      ok: true,
      records: await listManagedEmployeeDirectoryRecords(previewManagerPersonIdValue),
    };
  } catch (error) {
    // Expected session, capability and scoped-RPC failures must be returned as
    // a serialisable UI result. Throwing here makes Next turn a recoverable
    // directory error into its generic Server Components production message.
    console.warn("Managed team directory load was rejected or unavailable.", {
      reason: error instanceof Error ? error.message : "unknown",
    });
    return { ok: false, message: GENERIC_LIST_ERROR };
  }
}

/**
 * Narrow manager work-directory update. There is intentionally no create,
 * archive/delete, reporting-line, company, lifecycle or private-data input.
 */
export async function updateManagedEmployeeDirectoryRecord(
  input: UpdateManagedEmployeeDirectoryInput,
): Promise<ManagedEmployeeDirectoryMutationResult> {
  const inputValue = inputObject(input);
  const selectedManagerPersonId = previewManagerPersonId(inputValue.previewManagerPersonId);
  const updateValues = values(inputValue);

  const { supabase } = selectedManagerPersonId
    ? await requireManagedEmployeeDirectoryPreview()
    : await requireManagedEmployeeDirectoryManager();

  const response = selectedManagerPersonId
    ? await supabase.rpc("update_managed_employee_directory_record_for_preview", {
        p_manager_person_id: selectedManagerPersonId,
        ...updateValues,
      })
    : await supabase.rpc("update_managed_employee_directory_record", updateValues);
  if (response.error) throw mutationError(response.error);

  const personId = returnedPersonId(response.data);
  const record = await findManagedEmployeeDirectoryRecord(personId, selectedManagerPersonId);
  revalidatePath("/");
  return { record };
}
