import "server-only";

import { createClient } from "@/lib/supabase/server";
import type {
  EmployeeDirectoryCompany,
  EmployeeEmploymentType,
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

function employmentType(value: unknown): EmployeeEmploymentType | "" {
  if (value === null || value === undefined || value === "") return "";
  if (value === "abn" || value === "casual" || value === "full_time" || value === "part_time") {
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
  const timePattern = /^(?:[01]\d|2[0-3]):(?:00|15|30|45)$/;
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

function toRecord(row: DirectoryRpcRow): EmployeeDirectoryRecord {
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
    address: optionalText(row.address),
    dateOfBirth: optionalText(row.date_of_birth),
    startedDate: optionalText(row.started_date),
    scheduledEmploymentEndDate: optionalText(row.scheduled_employment_end_date),
    workingWeekdays: selectedWeekdays,
    workingDayTimes: workingDayTimes(row.working_day_times, selectedWeekdays),
    archiveReason: optionalText(row.archive_reason),
    employmentType: employmentType(row.employment_type),
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

  if (permissionError || allowed !== true) throw new Error(GENERIC_ACCESS_ERROR);

  return { supabase, actorUserId: userData.user.id };
}

export async function listEmployeeDirectoryRecordsForManager() {
  const { supabase } = await requireEmployeeDirectoryManager();
  return listEmployeeDirectoryRecordsWithClient(supabase);
}

export async function listEmployeeDirectoryRecordsWithClient(
  supabase: Awaited<ReturnType<typeof createClient>>,
) {
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

  return (archiveData as DirectoryRpcRow[])
    .map(toRecord)
    .sort((first, second) => first.fullName.localeCompare(second.fullName));
}

export async function findEmployeeDirectoryRecord(
  supabase: Awaited<ReturnType<typeof createClient>>,
  personId: string,
) {
  if (!UUID_PATTERN.test(personId)) throw new Error(GENERIC_LOAD_ERROR);
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
  return toRecord(data[0] as DirectoryRpcRow);
}
