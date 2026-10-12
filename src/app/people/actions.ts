"use server";

import { randomBytes } from "node:crypto";
import { requirePortalRoleActor } from "@/lib/portal-role-access";
import { ORDINARY_PORTAL_ROLES, type OrdinaryPortalRole, type PortalRole } from "@/lib/portal-role-capabilities";
import { createPortalAccount } from "@/app/accounts/actions";
import { requireEmployeeTeam } from "@/lib/employee-teams";
import { revalidatePath } from "next/cache";

import {
  findEmployeeDirectoryRecord,
  listEmployeeDirectoryRecordsForManager,
  requireEmployeeDirectoryManager,
} from "@/lib/employee-directory";
import { getOrganisationPersonWorkEmailForMember } from "@/lib/organisation-directory";
import { createAdminClient } from "@/lib/supabase/admin";
import { preparePortalAccountStatusChange, finalisePortalAccountStatusChange, recoverPortalAccountStatusChange } from "@/lib/portal-account-status";
import type {
  CreateEmployeeDirectoryInput,
  EmployeeDirectoryCompany,
  EmployeeTeamManagerDefault,
  EmployeeTeamManagerDefaultResult,
  EmployeeEmploymentType,
  EmployeeContractType,
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

function isMissingWorkScheduleRpc(error: { code?: string; message?: string } | null) {
  const message = error?.message?.toLocaleLowerCase() ?? "";
  return error?.code === "PGRST202"
    || (message.includes("could not find the function") && message.includes("work_schedule"));
}

type MutationRpcRow = {
  person_id: string;
};

type ArchivePersonRow = {
  auth_user_id: string | null;
  is_active: boolean;
};

type ArchiveProfileRow = {
  account_status: "active" | "disabled";
  account_version: number;
};

type ArchiveCommitPersonRow = {
  is_active: boolean;
};

class DirectoryInputError extends Error {}

class DirectoryCommittedReadError extends DirectoryInputError {
  constructor(readonly personId: string) {
    super("Employee details were saved, but the saved record could not be loaded. Refresh the directory before trying again. Do not create the employee again.");
  }
}

async function requireDirectoryMutationManager() {
  try {
    return await requireEmployeeDirectoryManager();
  } catch (error) {
    if (error instanceof Error && (
      error.message === "Your session has expired. Sign in again."
      || error.message === "You do not have permission to manage employee records."
    )) throw new DirectoryInputError(error.message);
    throw error;
  }
}

function validatedTeam(value: unknown) {
  try {
    return requireEmployeeTeam(value);
  } catch {
    throw new DirectoryInputError("Choose a team from the list.");
  }
}

function textValue(value: unknown, label: string) {
  if (typeof value !== "string") throw new DirectoryInputError(`${label} is invalid.`);
  return value;
}

function requiredText(value: unknown, label: string, maximum = 120) {
  const cleaned = textValue(value, label).trim();
  if (!cleaned || cleaned.length > maximum) throw new DirectoryInputError(`${label} is required and must be ${maximum} characters or fewer.`);
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
  if (cleaned.length > maximum) throw new DirectoryInputError(`${label} must be ${maximum} characters or fewer.`);
  return cleaned || null;
}

function optionalEmail(value: unknown, label: string) {
  const cleaned = optionalText(value, label, 254);
  if (cleaned && !EMAIL_PATTERN.test(cleaned)) throw new DirectoryInputError(`Enter a valid ${label.toLocaleLowerCase()}.`);
  return cleaned;
}

function optionalDate(value: unknown, label: string) {
  const cleaned = textValue(value, label).trim();
  if (!cleaned) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) throw new DirectoryInputError(`${label} must be a valid date.`);
  const [year, month, day] = cleaned.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new DirectoryInputError(`${label} must be a valid date.`);
  }
  return cleaned;
}

function optionalUuid(value: unknown, label: string) {
  if (!value) return null;
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new DirectoryInputError(`${label} is invalid.`);
  return value;
}

function company(value: unknown): EmployeeDirectoryCompany {
  if (value !== "mam" && value !== "equipsy") throw new DirectoryInputError(GENERIC_SAVE_ERROR);
  return value;
}

async function resolveTeamManagerDefault(
  supabase: Awaited<ReturnType<typeof requireEmployeeDirectoryManager>>["supabase"],
  companyKey: EmployeeDirectoryCompany,
  teamName: string,
): Promise<EmployeeTeamManagerDefault> {
  const { data, error } = await supabase.rpc("get_employee_team_manager_default", {
    p_company_key: companyKey,
    p_team_name: teamName,
  });
  if (error || !data || typeof data !== "object" || Array.isArray(data)) {
    throw new DirectoryInputError("Team Manager could not be checked. Refresh and try again.");
  }
  const result = data as Record<string, unknown>;
  if (result.status === "valid" && typeof result.managerId === "string" && UUID_PATTERN.test(result.managerId)
    && typeof result.managerName === "string" && result.managerName.trim()) {
    return { status: "valid", managerId: result.managerId, managerName: result.managerName };
  }
  if ((result.status === "missing" || result.status === "invalid") && result.managerId === null && result.managerName === "") {
    return { status: result.status, managerId: null, managerName: "" };
  }
  throw new DirectoryInputError("Team Manager could not be checked. Refresh and try again.");
}

export async function getEmployeeTeamManagerDefault(input: {
  company: EmployeeDirectoryCompany;
  teamName: string;
}): Promise<EmployeeTeamManagerDefaultResult> {
  try {
    const { supabase } = await requireDirectoryMutationManager();
    const value = inputObject(input);
    return await resolveTeamManagerDefault(supabase, company(value.company), validatedTeam(value.teamName));
  } catch (error) {
    return { error: error instanceof DirectoryInputError ? error.message : "Team Manager could not be checked. Refresh and try again." };
  }
}

function employmentType(value: unknown): EmployeeEmploymentType {
  if (value === "abn" || value === "casual" || value === "full_time" || value === "part_time" || value === "overseas") {
    return value;
  }
  throw new DirectoryInputError("Choose an employment type.");
}

function contractType(value: unknown): EmployeeContractType | null {
  if (value === "" || value === null || value === undefined) return null;
  if (value === "permanent" || value === "fixed_term") return value;
  throw new DirectoryInputError("Choose Permanent or Fixed-Term, or leave contract type unset.");
}

function workingWeekdays(value: unknown) {
  if (value === null || (Array.isArray(value) && value.length === 0)) return null;
  if (
    !Array.isArray(value)
    || value.length > 7
    || value.some((day) => !Number.isInteger(day) || day < 1 || day > 7)
    || new Set(value).size !== value.length
  ) {
    throw new DirectoryInputError("Choose valid, non-repeating work days.");
  }
  return [...value].sort((first, second) => first - second);
}

function workingDayTimes(value: unknown, selectedWeekdays: number[] | null) {
  if (!Array.isArray(value) || value.length > 7) {
    throw new DirectoryInputError("Work times are invalid.");
  }
  const selected = new Set(selectedWeekdays ?? []);
  const seen = new Set<number>();
  const timePattern = /^(?:[01]\d|2[0-3]):(?:00|15|30|45)$/;
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new DirectoryInputError("Work times are invalid.");
    }
    const row = candidate as Record<string, unknown>;
    const weekday = Number(row.weekday);
    const startTime = typeof row.startTime === "string" ? row.startTime : "";
    const endTime = typeof row.endTime === "string" ? row.endTime : "";
    if (
      !Number.isInteger(weekday)
      || !selected.has(weekday)
      || seen.has(weekday)
      || !timePattern.test(startTime)
      || !timePattern.test(endTime)
      || endTime <= startTime
    ) {
      throw new DirectoryInputError("Choose valid start and finish times in 15-minute intervals.");
    }
    seen.add(weekday);
    return { weekday, start_time: startTime, end_time: endTime };
  }).sort((first, second) => first.weekday - second.weekday);
}

function laptopSupplied(value: unknown) {
  const cleaned = optionalText(value, "Laptop supplied", 32);
  if (cleaned === null) return null;
  if (cleaned !== "own_laptop" && cleaned !== "mam_laptop") {
    throw new DirectoryInputError("Choose Own laptop or MAM laptop.");
  }
  return cleaned;
}

function assetTags(value: unknown) {
  if (!Array.isArray(value) || value.length > 24) {
    throw new DirectoryInputError("Asset tags must contain 24 values or fewer.");
  }

  const tags = value.map((tag) => {
    if (typeof tag !== "string") throw new DirectoryInputError("Asset tags are invalid.");
    const cleaned = tag.trim();
    if (!cleaned || cleaned.length > 80) {
      throw new DirectoryInputError("Each asset tag must be between 1 and 80 characters.");
    }
    return cleaned;
  });

  const tagKeys = new Set<string>();
  for (const tag of tags) {
    const key = tag.toLocaleLowerCase();
    if (tagKeys.has(key)) throw new DirectoryInputError("Asset tags must be unique.");
    tagKeys.add(key);
  }
  return tags;
}

function version(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DirectoryInputError(GENERIC_SAVE_ERROR);
  }
  return value;
}

function inputObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DirectoryInputError(GENERIC_SAVE_ERROR);
  return value as Record<string, unknown>;
}

function validateDraft(input: unknown) {
  const value = inputObject(input);
  const p_laptop_supplied = laptopSupplied(value.laptopSupplied);
  const p_laptop_id = optionalText(value.laptopId, "Laptop ID", 120);
  const p_working_weekdays = workingWeekdays(value.workingWeekdays);

  if (p_laptop_supplied === "mam_laptop" && !p_laptop_id) {
    throw new DirectoryInputError("A Laptop ID is required for a MAM laptop.");
  }

  return {
    p_first_name: requiredText(value.firstName, "First name", 80),
    p_last_name: optionalText(value.lastName, "Last name", 80),
    p_work_email: optionalEmail(value.workEmail, "Work email"),
    p_personal_email: optionalEmail(value.personalEmail, "Personal email"),
    p_phone: optionalText(value.phone, "Phone", 60),
    p_position_title: requiredText(value.positionTitle, "Job title"),
    p_team_name: validatedTeam(value.teamName),
    p_manager_id: optionalUuid(value.managerId, "Manager"),
    p_country: optionalText(value.country, "Country", 100),
    p_address: optionalText(value.address, "Address", 500),
    p_date_of_birth: optionalDate(value.dateOfBirth, "Date of birth"),
    p_started_date: optionalDate(value.startedDate, "Start date"),
    p_scheduled_employment_end_date: optionalDate(
      value.scheduledEmploymentEndDate,
      "Scheduled employment end date",
    ),
    p_working_weekdays,
    p_working_day_times: workingDayTimes(value.workingDayTimes, p_working_weekdays),
    p_employment_type: employmentType(value.employmentType),
    p_contract_type: contractType(value.contractType),
    p_company_key: company(value.company),
    p_is_active: value.isActive === true,
    p_laptop_supplied,
    p_laptop_id,
    p_mouse_id: optionalText(value.mouseId, "Mouse ID", 120),
    p_keyboard_id: optionalText(value.keyboardId, "Keyboard ID", 120),
    p_asset_tags: assetTags(value.assetTags),
  };
}

function legacyDraftValues(values: ReturnType<typeof validateDraft>) {
  const { p_working_weekdays, p_working_day_times, p_contract_type, ...legacyValues } = values;
  void p_working_day_times;
  void p_contract_type;
  if (p_working_weekdays !== null) {
    throw new DirectoryInputError("Work schedule storage is not ready. Refresh and try again.");
  }
  return legacyValues;
}

function returnedPersonId(data: unknown) {
  const row = (Array.isArray(data) ? data[0] : null) as MutationRpcRow | undefined;
  if (!row || !UUID_PATTERN.test(row.person_id)) throw new DirectoryInputError(GENERIC_SAVE_ERROR);
  return row.person_id;
}

function mutationErrorMessage(error: { code?: string; message?: string } | null) {
  if (error?.code === "55000" && error.message === "Onboarding credential delivery in progress") {
    return "This employee record is protected while onboarding credential delivery is in progress or awaiting administrator review. No changes were saved.";
  }
  const message = error?.message?.toLocaleLowerCase() ?? "";
  if (error?.code === "23505" && message.includes("employee_directory_details_laptop_id_unique_idx")) {
    return "That Laptop ID is already assigned to another employee.";
  }
  if (error?.code === "23505" && message.includes("employee_directory_details_mouse_id_unique_idx")) {
    return "That Mouse ID is already assigned to another employee.";
  }
  if (error?.code === "23505" && message.includes("employee_directory_details_keyboard_id_unique_idx")) {
    return "That Keyboard ID is already assigned to another employee.";
  }
  if (error?.code === "40001") {
    return "This record has changed. Refresh it, then try again.";
  }
  if (error?.message === "Choose an active employee as the manager." || error?.message === "Choose an active same-company employee as the manager." || error?.message === "This reporting link would create a cycle." || error?.message === "The selected parent org node does not exist.") {
    return "Choose a valid manager and try again.";
  }
  return GENERIC_SAVE_ERROR;
}

function safeRoleErrorMessage(error: { code?: string; message?: string } | null) {
  if (error?.code === "40001" || (error?.code === "PT409" && error.message === "Role has changed. Refresh and try again.")) {
    return "Role has changed. Refresh the directory and try again.";
  }
  if (error?.code === "55000" && error.message === "A password reset is in progress. Resolve it before changing this role.") {
    return "A password reset is in progress. Resolve it before changing this role.";
  }
  if (error?.code === "55000" && error.message === "Onboarding credential delivery in progress") {
    return mutationErrorMessage(error);
  }
  return "Role could not be saved. Refresh and try again.";
}

async function readSavedDirectoryRecord(
  supabase: Awaited<ReturnType<typeof requireEmployeeDirectoryManager>>["supabase"],
  personId: string,
) {
  try {
    return await findEmployeeDirectoryRecord(supabase, personId);
  } catch {
    throw new DirectoryCommittedReadError(personId);
  }
}

const CONTRACT_TYPE_NOT_SAVED = "Employee details were saved, but the contract type was not. Choose it again and save.";

async function saveContractClassification(
  supabase: Awaited<ReturnType<typeof requireEmployeeDirectoryManager>>["supabase"],
  personId: string,
  contractType: ReturnType<typeof validateDraft>["p_contract_type"],
) {
  try {
    const { error } = await supabase.rpc("set_employee_check_in_contract_classification", {
      p_person_id: personId,
      p_contract_type: contractType,
    });
    return error ? CONTRACT_TYPE_NOT_SAVED : undefined;
  } catch {
    return CONTRACT_TYPE_NOT_SAVED;
  }
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

export type DirectoryRole = OrdinaryPortalRole;
export type DirectoryStoredRole = PortalRole;

export async function listEmployeeDirectoryRoles(): Promise<Record<string, DirectoryStoredRole | null>> {
  const { supabase, capabilities } = await requirePortalRoleActor();
  if (!capabilities.is_super_admin || !capabilities.can_manage_roles) throw new Error("Only a Super Admin can manage roles.");
  const { data, error } = await supabase.rpc("list_employee_directory_roles");
  if (error || !Array.isArray(data)) throw new Error("Employee roles could not be loaded. Refresh and try again.");
  const roles: Record<string, DirectoryStoredRole | null> = {};
  for (const row of data) {
    if (!row || typeof row.person_id !== "string" || !UUID_PATTERN.test(row.person_id)) throw new Error(GENERIC_SAVE_ERROR);
    if (row.app_role !== null && ![...ORDINARY_PORTAL_ROLES, "system_admin"].includes(row.app_role)) throw new Error(GENERIC_SAVE_ERROR);
    roles[row.person_id] = row.app_role;
  }
  return roles;
}

export async function updateEmployeeDirectoryRole(input: {
  personId: string;
  role: DirectoryRole;
  expectedRole: DirectoryStoredRole;
}): Promise<DirectoryRole | { error: string; committed?: false } | { error: string; committed: true; personId: string }> {
  let committedPersonId: string | null = null;
  try {
    const value = inputObject(input);
    if (typeof value.personId !== "string" || !UUID_PATTERN.test(value.personId)
      || !ORDINARY_PORTAL_ROLES.includes(value.role as DirectoryRole)
      || !ORDINARY_PORTAL_ROLES.includes(value.expectedRole as DirectoryRole)) {
      throw new DirectoryInputError("Choose a valid role and refresh the employee record.");
    }
    const { supabase, capabilities } = await requirePortalRoleActor();
    if (!capabilities.is_super_admin || !capabilities.can_manage_roles) throw new DirectoryInputError("Only a Super Admin can change roles.");
    const { data, error } = await supabase.rpc("update_employee_directory_role", {
      p_person_id: value.personId,
      p_role: value.role,
      p_expected_role: value.expectedRole,
    });
    if (error || data !== value.role) {
      throw new DirectoryInputError(safeRoleErrorMessage(error));
    }
    committedPersonId = value.personId;
    revalidatePath("/");
    return data as DirectoryRole;
  } catch (error) {
    if (committedPersonId) return { committed: true, personId: committedPersonId, error: "Role was saved, but the directory could not be refreshed. Refresh the directory before trying again." };
    return { error: error instanceof DirectoryInputError ? error.message : "Role could not be saved. Refresh and try again." };
  }
}

export async function createEmployeeDirectoryRecord(
  input: CreateEmployeeDirectoryInput,
): Promise<EmployeeDirectoryMutationResult> {
  let committedPersonId: string | null = null;
  try {
    const { supabase } = await requireDirectoryMutationManager();
    const values = validateDraft(input);
    const { p_contract_type: selectedContractType, ...directoryValues } = values;
    if (values.p_is_active) {
      if (!values.p_started_date) throw new DirectoryInputError("A start date is required for a new active employee.");
    }
    if (values.p_manager_id !== null) {
      const manager = await findEmployeeDirectoryRecord(supabase, values.p_manager_id);
      if (manager.personId !== values.p_manager_id || !manager.isActive || manager.company !== values.p_company_key) {
        throw new DirectoryInputError("Choose a valid manager and try again.");
      }
    } else {
      const configured = await resolveTeamManagerDefault(supabase, values.p_company_key, values.p_team_name);
      if (configured.status === "invalid") {
        throw new DirectoryInputError("The configured Team Manager is not available. Choose a valid manager before saving.");
      }
    }
    let { data, error } = await supabase.rpc("create_employee_directory_record_with_work_schedule_times", {
      ...directoryValues,
      p_sort_order: 0,
    });
    if (isMissingWorkScheduleRpc(error) && values.p_working_day_times.length === 0) {
      const { p_working_day_times, ...weekdayValues } = directoryValues;
      void p_working_day_times;
      ({ data, error } = await supabase.rpc("create_employee_directory_record_with_work_schedule", {
        ...weekdayValues,
        p_sort_order: 0,
      }));
    }
    if (isMissingWorkScheduleRpc(error) && values.p_working_weekdays === null) {
      ({ data, error } = await supabase.rpc("create_employee_directory_record_with_employment_type", {
        ...legacyDraftValues({ ...directoryValues, p_contract_type: selectedContractType }),
        p_sort_order: 0,
      }));
    }
    if (isMissingWorkScheduleRpc(error)) {
      throw new DirectoryInputError("Work schedule storage is not ready. Refresh and try again.");
    }
    if (error) return { error: mutationErrorMessage(error) };

    const personId = returnedPersonId(data);
    committedPersonId = personId;
    // A new person has no classification, so only an explicit choice needs the
    // second call. The employee already exists; never turn its failure into a
    // save error that invites a duplicate create.
    let warning = selectedContractType === null
      ? undefined
      : await saveContractClassification(supabase, personId, selectedContractType);
    const record = await readSavedDirectoryRecord(supabase, personId);
    if (values.p_is_active && (values.p_work_email || values.p_personal_email)) {
      try {
        await createPortalAccount({
          personId,
          accountVersion: record.personVersion,
          loginName: values.p_work_email ?? values.p_personal_email!,
          newPassword: `${randomBytes(24).toString("base64url")}aA1!`,
        });
      } catch {
        warning = [warning, "Employee saved, but account creation needs administrator review. Do not create the employee again."].filter(Boolean).join(" ");
      }
    } else if (values.p_is_active) {
      warning = [warning, "Employee saved without a portal account because no email is recorded. Add an email and create the login in Accounts when available."].filter(Boolean).join(" ");
    }
    revalidatePath("/");
    return warning ? { record, warning } : { record };
  } catch (error) {
    if (error instanceof DirectoryCommittedReadError) return { committed: true, personId: error.personId, error: error.message };
    if (committedPersonId) return { committed: true, personId: committedPersonId, error: "Employee details were saved, but the directory could not be refreshed. Refresh the directory before trying again. Do not create the employee again." };
    return { error: error instanceof DirectoryInputError ? error.message : GENERIC_SAVE_ERROR };
  }
}

export async function updateEmployeeDirectoryRecord(
  input: UpdateEmployeeDirectoryInput,
): Promise<EmployeeDirectoryMutationResult> {
  let committedPersonId: string | null = null;
  try {
    const inputValue = inputObject(input);
    if (typeof inputValue.personId !== "string" || !UUID_PATTERN.test(inputValue.personId)) {
      throw new DirectoryInputError(GENERIC_SAVE_ERROR);
    }
    const { supabase } = await requireDirectoryMutationManager();
    const values = validateDraft(inputValue);
    const { p_contract_type: selectedContractType, ...directoryValues } = values;
    const currentRecord = await findEmployeeDirectoryRecord(supabase, inputValue.personId);
    directoryValues.p_manager_id = currentRecord.managerId;
    let { data, error } = await supabase.rpc("update_employee_directory_record_with_work_schedule_times", {
      ...directoryValues,
      p_person_id: inputValue.personId,
      p_expected_person_version: version(inputValue.personVersion),
      p_expected_detail_version: version(inputValue.detailVersion),
    });
    if (isMissingWorkScheduleRpc(error) && values.p_working_day_times.length === 0) {
      const { p_working_day_times, ...weekdayValues } = directoryValues;
      void p_working_day_times;
      ({ data, error } = await supabase.rpc("update_employee_directory_record_with_work_schedule", {
        ...weekdayValues,
        p_person_id: inputValue.personId,
        p_expected_person_version: version(inputValue.personVersion),
        p_expected_detail_version: version(inputValue.detailVersion),
      }));
    }
    if (isMissingWorkScheduleRpc(error) && values.p_working_weekdays === null) {
      ({ data, error } = await supabase.rpc("update_employee_directory_record_with_employment_type", {
        ...legacyDraftValues({ ...directoryValues, p_contract_type: selectedContractType }),
        p_person_id: inputValue.personId,
        p_expected_person_version: version(inputValue.personVersion),
        p_expected_detail_version: version(inputValue.detailVersion),
      }));
    }
    if (isMissingWorkScheduleRpc(error)) {
      throw new DirectoryInputError("Work schedule storage is not ready. Refresh and try again.");
    }
    if (error) return { error: mutationErrorMessage(error) };

    const personId = returnedPersonId(data);
    committedPersonId = personId;
    // The directory change is already committed; report a classification
    // failure against the fresh record instead of failing the whole save.
    const warning = await saveContractClassification(supabase, personId, selectedContractType);
    const record = await readSavedDirectoryRecord(supabase, personId);
    revalidatePath("/");
    return warning ? { record, warning } : { record };
  } catch (error) {
    if (error instanceof DirectoryCommittedReadError) return { committed: true, personId: error.personId, error: error.message };
    if (committedPersonId) return { committed: true, personId: committedPersonId, error: "Employee details were saved, but the directory could not be refreshed. Refresh the directory before trying again. Do not create the employee again." };
    return { error: error instanceof DirectoryInputError ? error.message : GENERIC_SAVE_ERROR };
  }
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
  let admin: ReturnType<typeof createAdminClient> | null = null;
  let targetAuthUserId: string | null = null;
  let databaseArchived = false;
  let statusChangeAttempted = false;
  let statusChangeToken: string | null = null;

  async function inspectArchiveCommitOutcome(personId: string) {
    if (!admin) return "unknown" as const;
    try {
      const { data: person, error: personError } = await admin
        .from("internal_org_people")
        .select("is_active")
        .eq("id", personId)
        .eq("node_kind", "person")
        .maybeSingle<ArchiveCommitPersonRow>();
      if (personError || !person) return "unknown" as const;

      // Without a status claim, the employee row is the entire transaction
      // outcome we need to identify. With a claim, confirm both rows before
      // attempting database-only finalisation; never restore Auth here.
      if (!statusChangeToken || !targetAuthUserId) {
        return person.is_active ? "rolled_back" as const : "committed" as const;
      }

      const { data: profile, error: profileError } = await admin
        .from("profiles")
        .select("account_status,account_version")
        .eq("id", targetAuthUserId)
        .maybeSingle<ArchiveProfileRow>();
      if (profileError || !profile) return "unknown" as const;
      if (!person.is_active && profile.account_status === "disabled") return "committed" as const;
      if (person.is_active && profile.account_status === "active") return "rolled_back" as const;
      return "unknown" as const;
    } catch {
      return "unknown" as const;
    }
  }


  try {
    const inputValue = inputObject(input);
    if (typeof inputValue.personId !== "string" || !UUID_PATTERN.test(inputValue.personId)) {
      return { ok: false, message: "The employee record is invalid." };
    }
    const endDate = optionalDate(inputValue.endDate, "End date");
    const reason = employmentEndReason(inputValue.reason);
    if (!endDate) return { ok: false, message: "Choose an employment end date." };
    const expectedPersonVersion = version(inputValue.personVersion);
    const expectedDetailVersion = version(inputValue.detailVersion);

    const { supabase, actorUserId } = await requireEmployeeDirectoryManager();
    const parts = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const today = (key: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === key)?.value ?? "";
    if (endDate > `${today("year")}-${today("month")}-${today("day")}`) {
      const { data, error } = await supabase.rpc("schedule_employee_offboarding", {
        p_person_id: inputValue.personId,
        p_expected_person_version: expectedPersonVersion,
        p_expected_detail_version: expectedDetailVersion,
        p_end_date: endDate,
        p_reason: reason,
      });
      if (error || data !== inputValue.personId) return { ok: false, message: error?.message ?? "The offboarding schedule could not be saved. Refresh and try again." };
      const record = await findEmployeeDirectoryRecord(supabase, inputValue.personId);
      revalidatePath("/");
      return { ok: true, record };
    }
    admin = createAdminClient();

    // The database RPC owns the transactional archive and profile-status
    // update. Auth is a separate provider: its exclusive executor must confirm
    // success first. Keep the claim on domain failure; never undo/retry Auth.
    const { data: person, error: personError } = await admin
      .from("internal_org_people")
      .select("auth_user_id,is_active")
      .eq("id", inputValue.personId)
      .eq("node_kind", "person")
      .maybeSingle<ArchivePersonRow>();
    if (personError || !person) {
      return { ok: false, message: "The employee record could not be found. Refresh and try again." };
    }

    targetAuthUserId = person.auth_user_id;
    if (targetAuthUserId === actorUserId) {
      return { ok: false, message: "You cannot end employment and disable your own portal account." };
    }

    if (person.is_active) {
      const { data: reports, error: reportsError } = await admin
        .from("internal_org_people")
        .select("id")
        .eq("parent_id", inputValue.personId)
        .eq("is_active", true)
        .limit(1);
      if (reportsError || !Array.isArray(reports)) {
        return { ok: false, message: "The employee's reporting links could not be checked. Refresh and try again." };
      }
      if (reports.length > 0) {
        return { ok: false, message: "Move or archive this employee's active direct reports first." };
      }
    }

    if (targetAuthUserId) {
      const { data: profile, error: profileError } = await admin
        .from("profiles")
        .select("account_status,account_version")
        .eq("id", targetAuthUserId)
        .maybeSingle<ArchiveProfileRow>();
      if (profileError) {
        return { ok: false, message: "The portal account could not be checked. No changes were made." };
      }

      if (!person.is_active) {
        if (profile?.account_status === "disabled" && await recoverPortalAccountStatusChange(supabase, {
          personId: inputValue.personId,
          userId: targetAuthUserId,
          enabled: false,
          accountVersion: profile.account_version,
        })) {
          const record = await findEmployeeDirectoryRecord(supabase, inputValue.personId);
          revalidatePath("/");
          return { ok: true, record };
        }
        return { ok: false, message: "Employment has already ended. Refresh the archived record; any unresolved account claim needs administrator reconciliation." };
      }

      if (profile?.account_status === "active") {
        statusChangeAttempted = true;
        const claim = await preparePortalAccountStatusChange(supabase, admin, {
          personId: inputValue.personId,
          userId: targetAuthUserId,
          enabled: false,
          accountVersion: profile.account_version,
        });
        statusChangeToken = claim.changeToken;
      }
    }

    if (!person.is_active) {
      return { ok: false, message: "Employment has already ended. Refresh the archived record." };
    }

    let archiveResult;
    try {
      archiveResult = await supabase.rpc("archive_employee_directory_record", {
        p_person_id: inputValue.personId,
        p_expected_person_version: expectedPersonVersion,
        p_expected_detail_version: expectedDetailVersion,
        p_end_date: endDate,
        p_archive_reason: reason,
      });
    } catch {
      // A transport failure does not reveal whether Postgres committed. Read
      // the authoritative rows before completing the database claim. A live or
      // ambiguous provider operation is never compensated or sent again.
      const outcome = await inspectArchiveCommitOutcome(inputValue.personId);
      if (outcome === "committed") {
        databaseArchived = true;
        archiveResult = {
          data: [{ person_id: inputValue.personId }],
          error: null,
        };
      } else if (outcome === "rolled_back") {
        return {
          ok: false,
          message: statusChangeToken
            ? "The employee profile could not be archived. Its portal account remains disabled with a pending claim; refresh and retry the archive."
            : "The employee profile could not be archived. Refresh and try again.",
        };
      } else {
        return {
          ok: false,
          message: statusChangeToken
            ? "The archive result could not be confirmed. The portal account remains disabled for safe reconciliation."
            : "The archive result could not be confirmed. Refresh before trying again.",
        };
      }
    }
    const { data, error } = archiveResult;
    if (error) {
      const withAccountNotice = (message: string) => statusChangeToken
        ? `${message} The portal account remains disabled with a pending claim; retry the archive after resolving this issue.`
        : message;
      const message = error.message?.toLocaleLowerCase() ?? "";
      if (message === "move or archive this employee's active direct reports first.") {
        return { ok: false, message: withAccountNotice("Move or archive this employee's active direct reports first.") };
      }
      if (message.includes("return of this employee") || message.includes("active it devices")) {
        return { ok: false, message: withAccountNotice("Record the employee’s hardware return date in Registered devices before ending employment.") };
      }
      if (message.includes("disable the portal account before archiving")) {
        return { ok: false, message: withAccountNotice("The combined archive and account-disable setup is not available yet. Refresh after the next release.") };
      }
      if (message.includes("reporting") || message.includes("account") || message.includes("manager") || message.includes("end date")) {
        return { ok: false, message: withAccountNotice(error.message) };
      }
      if (message.includes("changed") || message.includes("version")) {
        return { ok: false, message: withAccountNotice("This record has changed. Refresh it, then try again.") };
      }
      if (message.includes("could not find the function") || message.includes("schema cache") || message.includes("archive_employee_directory_record")) {
        return { ok: false, message: withAccountNotice("Profile archiving is not available until the profile lifecycle setup is applied. Ask an administrator to refresh the system setup.") };
      }
      return { ok: false, message: withAccountNotice("The employee profile could not be archived. Refresh and try again.") };
    }

    databaseArchived = true;

    if (targetAuthUserId && statusChangeToken) {
      try {
        await finalisePortalAccountStatusChange(supabase, {
          personId: inputValue.personId,
          userId: targetAuthUserId,
          changeToken: statusChangeToken,
        });
      } catch {
        return {
          ok: false,
          message: "Employment ended and the portal account was disabled, but its account claim needs reconciliation.",
        };
      }
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
    if (databaseArchived) {
      return { ok: false, message: "Employment ended and the portal account was disabled, but the archived record needs refreshing." };
    }
    return {
      ok: false,
      message: statusChangeAttempted
        ? "The account change is pending or needs provider reconciliation. Refresh before retrying the archive."
        : "The employee profile could not be archived. Refresh and try again.",
    };
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
