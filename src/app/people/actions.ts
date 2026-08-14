"use server";

import { revalidatePath } from "next/cache";

import {
  findEmployeeDirectoryRecord,
  listEmployeeDirectoryRecordsForManager,
  requireEmployeeDirectoryManager,
} from "@/lib/employee-directory";
import { getOrganisationPersonWorkEmailForMember } from "@/lib/organisation-directory";
import type {
  CreateEmployeeDirectoryInput,
  EmployeeDirectoryCompany,
  EmployeeDirectoryMutationResult,
  EmployeeDirectoryRecord,
  UpdateEmployeeDirectoryInput,
} from "@/lib/employee-directory-types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GENERIC_SAVE_ERROR = "Employee details could not be saved. Refresh and try again.";

type MutationRpcRow = {
  person_id: string;
};

function textValue(value: unknown, label: string) {
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  return value;
}

function requiredText(value: unknown, label: string, maximum = 120) {
  const cleaned = textValue(value, label).trim();
  if (!cleaned || cleaned.length > maximum) throw new Error(`${label} is required and must be ${maximum} characters or fewer.`);
  return cleaned;
}

function optionalText(value: unknown, label: string, maximum = 254) {
  const cleaned = textValue(value, label).trim();
  if (cleaned.length > maximum) throw new Error(`${label} must be ${maximum} characters or fewer.`);
  return cleaned || null;
}

function optionalEmail(value: unknown, label: string) {
  const cleaned = optionalText(value, label, 254);
  if (cleaned && !EMAIL_PATTERN.test(cleaned)) throw new Error(`Enter a valid ${label.toLocaleLowerCase()}.`);
  return cleaned;
}

function optionalDate(value: unknown, label: string) {
  const cleaned = textValue(value, label).trim();
  if (!cleaned) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) throw new Error(`${label} must be a valid date.`);
  const [year, month, day] = cleaned.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new Error(`${label} must be a valid date.`);
  }
  return cleaned;
}

function optionalUuid(value: unknown, label: string) {
  if (!value) return null;
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function company(value: unknown): EmployeeDirectoryCompany {
  if (value !== "mam" && value !== "equipsy") throw new Error(GENERIC_SAVE_ERROR);
  return value;
}

function version(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(GENERIC_SAVE_ERROR);
  }
  return value;
}

function inputObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(GENERIC_SAVE_ERROR);
  return value as Record<string, unknown>;
}

function validateDraft(input: unknown) {
  const value = inputObject(input);
  return {
    p_first_name: requiredText(value.firstName, "First name", 80),
    p_last_name: optionalText(value.lastName, "Last name", 80),
    p_work_email: optionalEmail(value.workEmail, "Work email"),
    p_personal_email: optionalEmail(value.personalEmail, "Personal email"),
    p_phone: optionalText(value.phone, "Phone", 60),
    p_position_title: requiredText(value.positionTitle, "Job title"),
    p_team_name: requiredText(value.teamName, "Team"),
    p_manager_id: optionalUuid(value.managerId, "Manager"),
    p_country: optionalText(value.country, "Country", 100),
    p_date_of_birth: optionalDate(value.dateOfBirth, "Date of birth"),
    p_started_date: optionalDate(value.startedDate, "Start date"),
    p_scheduled_employment_end_date: optionalDate(
      value.scheduledEmploymentEndDate,
      "Scheduled employment end date",
    ),
    p_company_key: company(value.company),
    p_is_active: value.isActive === true,
  };
}

function returnedPersonId(data: unknown) {
  const row = (Array.isArray(data) ? data[0] : null) as MutationRpcRow | undefined;
  if (!row || !UUID_PATTERN.test(row.person_id)) throw new Error(GENERIC_SAVE_ERROR);
  return row.person_id;
}

function mutationError(error: { message?: string } | null) {
  const message = error?.message?.toLocaleLowerCase() ?? "";
  if (message.includes("version") || message.includes("changed")) {
    return new Error("This record has changed. Refresh it, then try again.");
  }
  if (message.includes("manager") || message.includes("parent") || message.includes("cycle")) {
    return new Error("Choose a valid manager and try again.");
  }
  return new Error(GENERIC_SAVE_ERROR);
}

/** Returns only HR-authorised employee records; never account credentials. */
export async function listEmployeeDirectoryRecords(): Promise<EmployeeDirectoryRecord[]> {
  return listEmployeeDirectoryRecordsForManager();
}

/**
 * Resolves one selected colleague's work contact on demand. The server-side
 * data-access layer and database RPC both re-check internal membership.
 */
export async function getOrganisationPersonWorkEmail(
  personId: string,
): Promise<string | null> {
  return getOrganisationPersonWorkEmailForMember(personId);
}

export async function createEmployeeDirectoryRecord(
  input: CreateEmployeeDirectoryInput,
): Promise<EmployeeDirectoryMutationResult> {
  const { supabase } = await requireEmployeeDirectoryManager();
  const values = validateDraft(input);
  const { data, error } = await supabase.rpc("create_employee_directory_record", {
    ...values,
    p_sort_order: 0,
  });
  if (error) throw mutationError(error);

  const personId = returnedPersonId(data);
  const record = await findEmployeeDirectoryRecord(supabase, personId);
  revalidatePath("/");
  return { record };
}

export async function updateEmployeeDirectoryRecord(
  input: UpdateEmployeeDirectoryInput,
): Promise<EmployeeDirectoryMutationResult> {
  const inputValue = inputObject(input);
  if (typeof inputValue.personId !== "string" || !UUID_PATTERN.test(inputValue.personId)) {
    throw new Error(GENERIC_SAVE_ERROR);
  }
  const { supabase } = await requireEmployeeDirectoryManager();
  const values = validateDraft(inputValue);
  const { data, error } = await supabase.rpc("update_employee_directory_record", {
    ...values,
    p_person_id: inputValue.personId,
    p_expected_person_version: version(inputValue.personVersion),
    p_expected_detail_version: version(inputValue.detailVersion),
  });
  if (error) throw mutationError(error);

  const personId = returnedPersonId(data);
  const record = await findEmployeeDirectoryRecord(supabase, personId);
  revalidatePath("/");
  return { record };
}
