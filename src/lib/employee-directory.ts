import "server-only";

import { createClient } from "@/lib/supabase/server";
import type {
  EmployeeDirectoryCompany,
  EmployeeEmploymentType,
  EmployeeLocation,
  EmployeeTimesheetEntries,
  EmployeeContractType,
  EmployeeLaptopSupply,
  EmployeeDirectoryRecord,
  EmployeeWorkingDayTime,
  EmployeeWorkingWeekday,
} from "@/lib/employee-directory-types";

type DirectoryRpcRow = {
  person_id: string;
  person_version: number | string;
  detail_version: number | string;
  company_key: string;
  is_active: boolean;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  position_title: string | null;
  team_name: string | null;
  manager_id: string | null;
  manager_name: string | null;
  work_email: string | null;
  personal_email: string | null;
  phone: string | null;
  country: string | null;
  location?: string | null;
  timesheet_entries?: string | null;
  expected_weekly_hours?: number | string | null;
  address: string | null;
  date_of_birth: string | null;
  started_date: string | null;
  scheduled_employment_end_date: string | null;
  working_weekdays: number[] | null;
  working_day_times?: unknown;
  archive_reason: string | null;
  employment_type: string | null;
  has_paid_leave_entitlement: boolean;
  laptop_supplied: string | null;
  laptop_id: string | null;
  mouse_id: string | null;
  keyboard_id: string | null;
  asset_tags: string[] | null;
};

const GENERIC_ACCESS_ERROR = "You do not have permission to manage employee records.";
const GENERIC_LOAD_ERROR = "Employee records could not be loaded. Refresh and try again.";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isMissingWorkScheduleRpc(error: { code?: string; message?: string } | null) {
  const message = error?.message?.toLocaleLowerCase() ?? "";
  return error?.code === "PGRST202"
    || (message.includes("could not find the function") && message.includes("work_schedule"));
}

function optionalText(value: unknown) {
  return typeof value === "string" ? value : "";
}

function requiredText(value: unknown) {
  const text = optionalText(value).trim();
  if (!text) throw new Error(GENERIC_LOAD_ERROR);
  return text;
}

function version(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(GENERIC_LOAD_ERROR);
  return parsed;
}

function company(value: unknown): EmployeeDirectoryCompany {
  if (value === "mam" || value === "equipsy") return value;
  throw new Error(GENERIC_LOAD_ERROR);
}

function laptopSupply(value: unknown): EmployeeLaptopSupply {
  if (value === null || value === undefined || value === "") return "";
  if (value === "own_laptop" || value === "mam_laptop") return value;
  throw new Error(GENERIC_LOAD_ERROR);
}

function timesheetEntries(value: unknown): EmployeeTimesheetEntries {
  if (value == null || value === "") return "";
  if (value === "aroflo" || value === "deputy" || value === "hubstaff"
    || value === "deputy_hubstaff" || value === "aroflo_hubstaff" || value === "aroflo_deputy") return value;
  throw new Error(GENERIC_LOAD_ERROR);
}
function expectedWeeklyHours(value: unknown): string {
  if (value == null || value === "") return "";
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || num > 168) throw new Error(GENERIC_LOAD_ERROR);
  return String(num);
}

function location(value: unknown): EmployeeLocation {
  if (value === null || value === undefined || value === "") return "";
  if (value === "hq" || value === "onsite_trade" || value === "remote_worker" || value === "hybrid") return value;
  throw new Error(GENERIC_LOAD_ERROR);
}

function employmentType(value: unknown): EmployeeEmploymentType | "" {
  if (value === null || value === undefined || value === "") return "";
  if (value === "abn" || value === "casual" || value === "full_time" || value === "part_time" || value === "overseas") {
    return value;
  }
  throw new Error(GENERIC_LOAD_ERROR);
}

function workingWeekdays(value: unknown): EmployeeWorkingWeekday[] | null {
  if (value === null || value === undefined) return null;
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > 7
    || value.some((day) => !Number.isInteger(day) || day < 1 || day > 7)
    || new Set(value).size !== value.length
  ) {
    throw new Error(GENERIC_LOAD_ERROR);
  }
  return [...value].sort((first, second) => first - second) as EmployeeWorkingWeekday[];
}

function workingDayTimes(
  value: unknown,
  selectedWeekdays: EmployeeWorkingWeekday[] | null,
): EmployeeWorkingDayTime[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > 7) throw new Error(GENERIC_LOAD_ERROR);
  const selected = new Set(selectedWeekdays ?? []);
  const seen = new Set<number>();
  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  const result: EmployeeWorkingDayTime[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(GENERIC_LOAD_ERROR);
    }
    const row = candidate as Record<string, unknown>;
    if (
      !Number.isInteger(row.weekday)
      || !selected.has(Number(row.weekday) as EmployeeWorkingWeekday)
      || seen.has(Number(row.weekday))
      || typeof row.start_time !== "string"
      || typeof row.end_time !== "string"
      || !timePattern.test(row.start_time)
      || !timePattern.test(row.end_time)
      || row.end_time <= row.start_time
    ) throw new Error(GENERIC_LOAD_ERROR);
    seen.add(Number(row.weekday));
    result.push({
      weekday: Number(row.weekday) as EmployeeWorkingWeekday,
      startTime: row.start_time,
      endTime: row.end_time,
    });
  }
  return result.sort((first, second) => first.weekday - second.weekday);
}

function assetTags(value: unknown) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) {
    throw new Error(GENERIC_LOAD_ERROR);
  }
  return value;
}

function toRecord(row: DirectoryRpcRow, contractType: EmployeeContractType | ""): EmployeeDirectoryRecord {
  const selectedWeekdays = workingWeekdays(row.working_weekdays);
  return {
    personId: requiredText(row.person_id),
    personVersion: version(row.person_version),
    detailVersion: version(row.detail_version),
    company: company(row.company_key),
    isActive: row.is_active === true,
    firstName: optionalText(row.first_name),
    lastName: optionalText(row.last_name),
    fullName: requiredText(row.full_name),
    positionTitle: requiredText(row.position_title),
    teamName: optionalText(row.team_name),
    managerId: typeof row.manager_id === "string" ? row.manager_id : null,
    managerName: optionalText(row.manager_name),
    workEmail: optionalText(row.work_email),
    personalEmail: optionalText(row.personal_email),
    phone: optionalText(row.phone),
    country: optionalText(row.country),
    location: location(row.location),
    timesheetEntries: timesheetEntries(row.timesheet_entries),
    expectedWeeklyHours: expectedWeeklyHours(row.expected_weekly_hours),
    address: optionalText(row.address),
    dateOfBirth: optionalText(row.date_of_birth),
    startedDate: optionalText(row.started_date),
    scheduledEmploymentEndDate: optionalText(row.scheduled_employment_end_date),
    workingWeekdays: selectedWeekdays,
    workingDayTimes: workingDayTimes(row.working_day_times, selectedWeekdays),
    archiveReason: optionalText(row.archive_reason),
    employmentType: employmentType(row.employment_type),
    contractType,
    hasPaidLeaveEntitlement: row.has_paid_leave_entitlement === true,
    laptopSupplied: laptopSupply(row.laptop_supplied),
    laptopId: optionalText(row.laptop_id),
    mouseId: optionalText(row.mouse_id),
    keyboardId: optionalText(row.keyboard_id),
    assetTags: assetTags(row.asset_tags),
  };
}

export async function requireEmployeeDirectoryManager() {
  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();

  if (userError || !userData.user) {
    throw new Error("Your session has expired. Sign in again.");
  }

  const { data: allowed, error: permissionError } = await supabase
    .rpc("can_manage_employee_directory");

  if (permissionError?.code === "42501" || (!permissionError && allowed === false)) throw new Error(GENERIC_ACCESS_ERROR);
  if (permissionError || allowed !== true) throw new Error(GENERIC_LOAD_ERROR);

  return { supabase, actorUserId: userData.user.id };
}

export async function listEmployeeDirectoryRecordsForManager() {
  const { supabase } = await requireEmployeeDirectoryManager();
  return listEmployeeDirectoryRecordsWithClient(supabase);
}

async function listContractTypes(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: contractRows, error: contractError } = await supabase.rpc("list_employee_check_in_contract_classifications");
  if (contractError || !Array.isArray(contractRows)) throw new Error(GENERIC_LOAD_ERROR);
  const contractTypes = new Map<string, EmployeeContractType>();
  for (const item of contractRows) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(GENERIC_LOAD_ERROR);
    const row = item as Record<string, unknown>;
    if (typeof row.person_id !== "string" || !UUID_PATTERN.test(row.person_id)) throw new Error(GENERIC_LOAD_ERROR);
    if (row.contract_type !== "permanent" && row.contract_type !== "fixed_term") throw new Error(GENERIC_LOAD_ERROR);
    contractTypes.set(row.person_id, row.contract_type);
  }
  return contractTypes;
}

async function listProfileExtras(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data, error } = await supabase.rpc("list_employee_directory_profile_extras");
  if (error || !Array.isArray(data)) throw new Error(GENERIC_LOAD_ERROR);
  const extras = new Map<string, { timesheet_entries: string | null; expected_weekly_hours: number | null }>();
  for (const item of data) {
    if (!item || typeof item.person_id !== "string" || !UUID_PATTERN.test(item.person_id)) throw new Error(GENERIC_LOAD_ERROR);
    extras.set(item.person_id, { timesheet_entries: item.timesheet_entries, expected_weekly_hours: item.expected_weekly_hours });
  }
  return extras;
}

async function listLocations(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data, error } = await supabase.rpc("list_employee_directory_locations");
  if (error || !Array.isArray(data)) throw new Error(GENERIC_LOAD_ERROR);
  const locations = new Map<string, EmployeeLocation>();
  for (const item of data) {
    if (!item || typeof item !== "object" || typeof item.person_id !== "string" || !UUID_PATTERN.test(item.person_id)) {
      throw new Error(GENERIC_LOAD_ERROR);
    }
    locations.set(item.person_id, location(item.location));
  }
  return locations;
}

async function listDirectoryRows(supabase: Awaited<ReturnType<typeof createClient>>) {
  let { data: archiveData, error: archiveError } = await supabase.rpc("list_employee_directory_records_with_work_schedule_times", {
    p_include_archived: true,
  });
  if (isMissingWorkScheduleRpc(archiveError)) {
    ({ data: archiveData, error: archiveError } = await supabase.rpc("list_employee_directory_records_with_work_schedule", {
      p_include_archived: true,
    }));
  }
  if (isMissingWorkScheduleRpc(archiveError)) {
    ({ data: archiveData, error: archiveError } = await supabase.rpc("list_employee_directory_records_with_archive_visibility", {
      p_include_archived: true,
    }));
  }
  if (archiveError || !Array.isArray(archiveData)) throw new Error(GENERIC_LOAD_ERROR);
  return archiveData as DirectoryRpcRow[];
}

async function getDirectoryRow(supabase: Awaited<ReturnType<typeof createClient>>, personId: string) {
  let { data, error } = await supabase.rpc("get_employee_directory_record_with_work_schedule_times", {
    p_person_id: personId,
  });
  if (isMissingWorkScheduleRpc(error)) {
    ({ data, error } = await supabase.rpc("get_employee_directory_record_with_work_schedule", {
      p_person_id: personId,
    }));
  }
  if (isMissingWorkScheduleRpc(error)) {
    ({ data, error } = await supabase.rpc("get_employee_directory_record_with_archive_visibility", {
      p_person_id: personId,
    }));
  }
  if (error || !Array.isArray(data) || data.length !== 1) throw new Error(GENERIC_LOAD_ERROR);
  return data[0] as DirectoryRpcRow;
}

export async function listEmployeeDirectoryRecordsWithClient(
  supabase: Awaited<ReturnType<typeof createClient>>,
) {
  // The two reads are independent, so neither waits for the other.
  const [rows, contractTypes, locations, profileExtras] = await Promise.all([listDirectoryRows(supabase), listContractTypes(supabase), listLocations(supabase), listProfileExtras(supabase)]);
  return rows
    .map((row) => toRecord({ ...row, location: locations.get(row.person_id) ?? "", ...(profileExtras.get(row.person_id) ?? {}) }, contractTypes.get(row.person_id) ?? ""))
    .sort((first, second) => first.fullName.localeCompare(second.fullName));
}

export async function findEmployeeDirectoryRecord(
  supabase: Awaited<ReturnType<typeof createClient>>,
  personId: string,
) {
  if (!UUID_PATTERN.test(personId)) throw new Error(GENERIC_LOAD_ERROR);
  const [row, contractTypes, locationResult, extrasResult] = await Promise.all([
    getDirectoryRow(supabase, personId),
    listContractTypes(supabase),
    supabase.rpc("get_employee_directory_location", { p_person_id: personId }),
    supabase.rpc("get_employee_directory_profile_extras", { p_person_id: personId }),
  ]);
  if (locationResult.error || extrasResult.error || !Array.isArray(extrasResult.data) || extrasResult.data.length !== 1) throw new Error(GENERIC_LOAD_ERROR);
  return toRecord({ ...row, location: locationResult.data, ...extrasResult.data[0] }, contractTypes.get(personId) ?? "");
}
