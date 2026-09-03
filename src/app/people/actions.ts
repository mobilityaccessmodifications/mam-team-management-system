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
  EmployeeEmploymentType,
  EmployeeDirectoryMutationResult,
  EmployeeDirectoryRecord,
  UpdateEmployeeDirectoryInput,
} from "@/lib/employee-directory-types";

// PostgreSQL accepts UUIDs with any version/variant bits. Some imported
// directory IDs are deterministic values, so do not reject valid IDs merely
// because they are not RFC-versioned UUIDs.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GENERIC_SAVE_ERROR = "Employee details could not be saved. Refresh and try again.";
const EMPLOYMENT_END_REASONS = new Set([
  "Resigned",
  "Terminated",
  "End of contract",
  "Redundant",
  "Other",
]);

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

function employmentEndReason(value: unknown) {
  const reason = requiredText(value, "Employment end reason", 120);
  if (!EMPLOYMENT_END_REASONS.has(reason)) {
    throw new Error("Choose a valid employment end reason.");
  }
  return reason;
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

function employmentType(value: unknown): EmployeeEmploymentType {
  if (value === "abn" || value === "casual" || value === "full_time" || value === "part_time") {
    return value;
  }
  throw new Error("Choose an employment type.");
}

function laptopSupplied(value: unknown) {
  const cleaned = optionalText(value, "Laptop supplied", 32);
  if (cleaned === null) return null;
  if (cleaned !== "own_laptop" && cleaned !== "mam_laptop") {
    throw new Error("Choose Own laptop or MAM laptop.");
  }
  return cleaned;
}

function assetTags(value: unknown) {
  if (!Array.isArray(value) || value.length > 24) {
    throw new Error("Asset tags must contain 24 values or fewer.");
  }

  const tags = value.map((tag) => {
    if (typeof tag !== "string") throw new Error("Asset tags are invalid.");
    const cleaned = tag.trim();
    if (!cleaned || cleaned.length > 80) {
      throw new Error("Each asset tag must be between 1 and 80 characters.");
    }
    return cleaned;
  });

  const tagKeys = new Set<string>();
  for (const tag of tags) {
    const key = tag.toLocaleLowerCase();
    if (tagKeys.has(key)) throw new Error("Asset tags must be unique.");
    tagKeys.add(key);
  }
  return tags;
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
  const p_laptop_supplied = laptopSupplied(value.laptopSupplied);
  const p_laptop_id = optionalText(value.laptopId, "Laptop ID", 120);

  if (p_laptop_supplied === "mam_laptop" && !p_laptop_id) {
    throw new Error("A Laptop ID is required for a MAM laptop.");
  }

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
    p_address: optionalText(value.address, "Address", 500),
    p_date_of_birth: optionalDate(value.dateOfBirth, "Date of birth"),
    p_started_date: optionalDate(value.startedDate, "Start date"),
    p_scheduled_employment_end_date: optionalDate(
      value.scheduledEmploymentEndDate,
      "Scheduled employment end date",
    ),
    p_employment_type: employmentType(value.employmentType),
    p_company_key: company(value.company),
    p_is_active: value.isActive === true,
    p_laptop_supplied,
    p_laptop_id,
    p_mouse_id: optionalText(value.mouseId, "Mouse ID", 120),
    p_keyboard_id: optionalText(value.keyboardId, "Keyboard ID", 120),
    p_asset_tags: assetTags(value.assetTags),
  };
}

function returnedPersonId(data: unknown) {
  const row = (Array.isArray(data) ? data[0] : null) as MutationRpcRow | undefined;
  if (!row || !UUID_PATTERN.test(row.person_id)) throw new Error(GENERIC_SAVE_ERROR);
  return row.person_id;
}

function mutationError(error: { message?: string } | null) {
  const message = error?.message?.toLocaleLowerCase() ?? "";
  if (message.includes("laptop_id_unique")) {
    return new Error("That Laptop ID is already assigned to another employee.");
  }
  if (message.includes("mouse_id_unique")) {
    return new Error("That Mouse ID is already assigned to another employee.");
  }
  if (message.includes("keyboard_id_unique")) {
    return new Error("That Keyboard ID is already assigned to another employee.");
  }
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
  const { data, error } = await supabase.rpc("create_employee_directory_record_with_employment_type", {
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
  const { data, error } = await supabase.rpc("update_employee_directory_record_with_employment_type", {
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

export type ArchiveEmployeeDirectoryResult =
  | { ok: true; record: EmployeeDirectoryRecord }
  | { ok: false; message: string };

export async function archiveEmployeeDirectoryRecord(input: {
  personId: string;
  personVersion: number;
  detailVersion: number;
  endDate: string;
  reason: string;
}): Promise<ArchiveEmployeeDirectoryResult> {
  try {
    const inputValue = inputObject(input);
    if (typeof inputValue.personId !== "string" || !UUID_PATTERN.test(inputValue.personId)) {
      return { ok: false, message: "The employee record is invalid." };
    }
    const endDate = optionalDate(inputValue.endDate, "End date");
    const reason = employmentEndReason(inputValue.reason);
    if (!endDate) return { ok: false, message: "Choose an employment end date." };

    const { supabase } = await requireEmployeeDirectoryManager();
    const { data, error } = await supabase.rpc("archive_employee_directory_record", {
      p_person_id: inputValue.personId,
      p_expected_person_version: version(inputValue.personVersion),
      p_expected_detail_version: version(inputValue.detailVersion),
      p_end_date: endDate,
      p_archive_reason: reason,
    });
    if (error) {
      const message = error.message?.toLocaleLowerCase() ?? "";
      if (message.includes("return of this employee") || message.includes("active it devices")) {
        return { ok: false, message: "Record the employee’s hardware return date in Registered devices before ending employment." };
      }
      if (message.includes("reporting") || message.includes("account") || message.includes("manager") || message.includes("end date")) {
        return { ok: false, message: error.message };
      }
      if (message.includes("changed") || message.includes("version")) {
        return { ok: false, message: "This record has changed. Refresh it, then try again." };
      }
      if (message.includes("could not find the function") || message.includes("schema cache") || message.includes("archive_employee_directory_record")) {
        return { ok: false, message: "Profile archiving is not available until the profile lifecycle setup is applied. Ask an administrator to refresh the system setup." };
      }
      return { ok: false, message: "The employee profile could not be archived. Refresh and try again." };
    }

    const returned = Array.isArray(data) ? data[0] : data;
    const returnedId = returned && typeof returned === "object" && "person_id" in returned
      ? (returned as { person_id?: unknown }).person_id
      : undefined;
    if (typeof returnedId !== "string" || !UUID_PATTERN.test(returnedId)) {
      return { ok: false, message: "The employee profile could not be archived. Refresh and try again." };
    }

    const record = await findEmployeeDirectoryRecord(supabase, returnedId);
    revalidatePath("/");
    return { ok: true, record };
  } catch {
    return { ok: false, message: "The employee profile could not be archived. Refresh and try again." };
  }
}

export type DeleteEmployeeDirectoryResult =
  | { ok: true; personId: string }
  | { ok: false; message: string };

export async function deleteEmployeeDirectoryRecord(input: {
  personId: string;
  personVersion: number;
}): Promise<DeleteEmployeeDirectoryResult> {
  try {
    const inputValue = inputObject(input);
    if (typeof inputValue.personId !== "string" || !UUID_PATTERN.test(inputValue.personId)) {
      return { ok: false, message: "The employee record is invalid." };
    }

    const { supabase } = await requireEmployeeDirectoryManager();
    const { data, error } = await supabase.rpc("delete_employee_directory_record", {
      p_person_id: inputValue.personId,
      p_expected_person_version: version(inputValue.personVersion),
    });

    if (error) {
      const rawMessage = error.message ?? "";
      const message = rawMessage.toLocaleLowerCase();
      if (message.includes("deactivate") || message.includes("unlink") || message.includes("reporting line") || message.includes("check-in history") || message.includes("authoritative roster") || message.includes("referenced")) {
        return { ok: false, message: rawMessage };
      }
      if (message.includes("changed") || message.includes("version")) {
        return { ok: false, message: "This record has changed. Refresh it, then try again." };
      }
      if (message.includes("could not find the function") || message.includes("schema cache") || message.includes("delete_employee_directory_record")) {
        return { ok: false, message: "Profile deletion is not available until the profile lifecycle setup is applied. Ask an administrator to refresh the system setup." };
      }
      return { ok: false, message: "The employee profile could not be deleted. Refresh and try again." };
    }

    const returned = Array.isArray(data) ? data[0] : data;
    const returnedId = typeof returned === "string"
      ? returned
      : returned && typeof returned === "object" && "delete_employee_directory_record" in returned
        ? (returned as { delete_employee_directory_record?: unknown }).delete_employee_directory_record
        : undefined;
    if (typeof returnedId !== "string" || !UUID_PATTERN.test(returnedId)) {
      return { ok: false, message: "The employee profile could not be deleted. Refresh and try again." };
    }

    revalidatePath("/");
    return { ok: true, personId: returnedId };
  } catch {
    // Expected database and authorization failures must be returned as data.
    // Throwing from a Server Action is rendered as an opaque RSC error in
    // production, which hides the actionable reason from the HR user.
    return { ok: false, message: "The employee profile could not be deleted. Refresh and try again." };
  }
}
