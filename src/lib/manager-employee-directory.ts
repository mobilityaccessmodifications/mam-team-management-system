import "server-only";

import { createClient } from "@/lib/supabase/server";
import type {
  EmployeeDirectoryCompany,
  ManagedEmployeeDirectoryRecord,
} from "@/lib/employee-directory-types";

type ManagedDirectoryRpcRow = {
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
  manager_name: string | null;
  work_email: string | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERIC_ACCESS_ERROR = "You do not have permission to manage this team directory.";
const GENERIC_LOAD_ERROR = "Team employee records could not be loaded. Refresh and try again.";

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

function managerPersonId(value: string) {
  if (!UUID_PATTERN.test(value)) throw new Error(GENERIC_ACCESS_ERROR);
  return value;
}

function toManagedRecord(row: ManagedDirectoryRpcRow): ManagedEmployeeDirectoryRecord {
  if (row.is_active !== true) throw new Error(GENERIC_LOAD_ERROR);

  return {
    personId: requiredText(row.person_id),
    personVersion: version(row.person_version),
    detailVersion: version(row.detail_version),
    company: company(row.company_key),
    isActive: true,
    firstName: optionalText(row.first_name),
    lastName: optionalText(row.last_name),
    fullName: requiredText(row.full_name),
    positionTitle: requiredText(row.position_title),
    teamName: optionalText(row.team_name),
    managerName: optionalText(row.manager_name),
    workEmail: optionalText(row.work_email),
  };
}

async function requireActiveSession() {
  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();

  if (userError || !userData.user) {
    throw new Error("Your session has expired. Sign in again.");
  }

  return { supabase, actorUserId: userData.user.id };
}

/** Requires a real active manager, based only on the server-side account link. */
export async function requireManagedEmployeeDirectoryManager() {
  const session = await requireActiveSession();
  const { data: allowed, error } = await session.supabase.rpc("can_manage_team_employee_directory");
  if (error || allowed !== true) throw new Error(GENERIC_ACCESS_ERROR);
  return session;
}

/**
 * Change profile is a Super Admin test mode. The selected manager scope is
 * still checked by the database RPC; this simply prevents a regular manager
 * from supplying a different manager root to a Server Action.
 */
export async function requireManagedEmployeeDirectoryPreview() {
  const session = await requireActiveSession();
  const { data: allowed, error } = await session.supabase.rpc("can_manage_employee_directory");
  if (error || allowed !== true) throw new Error(GENERIC_ACCESS_ERROR);
  return session;
}

export async function listManagedEmployeeDirectoryRecords(
  previewManagerPersonId?: string,
): Promise<ManagedEmployeeDirectoryRecord[]> {
  const isPreview = typeof previewManagerPersonId === "string" && previewManagerPersonId.length > 0;
  const { supabase } = isPreview
    ? await requireManagedEmployeeDirectoryPreview()
    : await requireManagedEmployeeDirectoryManager();

  const response = isPreview
    ? await supabase.rpc("list_managed_employee_directory_records_for_preview", {
        p_manager_person_id: managerPersonId(previewManagerPersonId),
      })
    : await supabase.rpc("list_managed_employee_directory_records");

  if (response.error || !Array.isArray(response.data)) throw new Error(GENERIC_LOAD_ERROR);

  return (response.data as ManagedDirectoryRpcRow[])
    .map(toManagedRecord)
    .sort((first, second) => first.fullName.localeCompare(second.fullName, undefined, { sensitivity: "base" }));
}

export async function findManagedEmployeeDirectoryRecord(
  personId: string,
  previewManagerPersonId?: string,
) {
  const targetPersonId = managerPersonId(personId);
  const records = await listManagedEmployeeDirectoryRecords(previewManagerPersonId);
  const record = records.find((candidate) => candidate.personId === targetPersonId);
  if (!record) throw new Error(GENERIC_LOAD_ERROR);
  return record;
}

export function isManagedDirectoryUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
