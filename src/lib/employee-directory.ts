import "server-only";

import { createClient } from "@/lib/supabase/server";
import type {
  EmployeeDirectoryCompany,
  EmployeeLaptopSupply,
  EmployeeDirectoryRecord,
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
  archive_reason: string | null;
  laptop_supplied: string | null;
  laptop_id: string | null;
  mouse_id: string | null;
  keyboard_id: string | null;
  asset_tags: string[] | null;
};

const GENERIC_ACCESS_ERROR = "You do not have permission to manage employee records.";
const GENERIC_LOAD_ERROR = "Employee records could not be loaded. Refresh and try again.";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function assetTags(value: unknown) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) {
    throw new Error(GENERIC_LOAD_ERROR);
  }
  return value;
}

function toRecord(row: DirectoryRpcRow): EmployeeDirectoryRecord {
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
    archiveReason: optionalText(row.archive_reason),
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
  const { data: archiveData, error: archiveError } = await supabase.rpc("list_employee_directory_records_with_archive_visibility", {
    p_include_archived: true,
  });
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
  const { data, error } = await supabase.rpc("get_employee_directory_record_with_archive_visibility", {
    p_person_id: personId,
  });
  if (error || !Array.isArray(data) || data.length !== 1) throw new Error(GENERIC_LOAD_ERROR);
  return toRecord(data[0] as DirectoryRpcRow);
}
