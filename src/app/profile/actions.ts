"use server";

import { revalidatePath } from "next/cache";

import type { SelfProfileChanges, SelfProfileData } from "@/components/self-profile-menu";
import { requireEmployeeDirectoryManager } from "@/lib/employee-directory";
import { createClient } from "@/lib/supabase/server";

type SelfProfileRpcRow = {
  person_id?: string | null;
  full_name: string | null;
  position_title: string | null;
  company_key: string | null;
  team_name: string | null;
  manager_name: string | null;
  work_email: string | null;
  personal_email: string | null;
  phone: string | null;
  date_of_birth: string | null;
  detail_version: number | string | null;
  has_detail: boolean | null;
};

export type CurrentEmployeeSelfProfile = SelfProfileData & {
  detailVersion: number;
  hasDetail: boolean;
};

/**
 * An HR-authorised, selected employee profile for the Change view control.
 * This is never returned by the self-service profile actions.
 */
export type SelectedEmployeeProfile = SelfProfileData & {
  personId: string;
  detailVersion: number;
  hasDetail: boolean;
};

type UpdateSelfProfileInput = SelfProfileChanges & {
  detailVersion: number;
};

type UpdateSelectedEmployeeProfileInput = SelfProfileChanges & {
  personId: string;
  detailVersion: number;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERIC_LOAD_ERROR = "Your profile could not be loaded. Refresh and try again.";
const GENERIC_SAVE_ERROR = "Your profile changes could not be saved. Check the details and try again.";
const GENERIC_SELECTED_PROFILE_LOAD_ERROR = "Employee profile could not be loaded. Refresh and try again.";
const GENERIC_SELECTED_PROFILE_SAVE_ERROR = "Employee profile changes could not be saved. Check the details and try again.";
const STALE_PROFILE_MESSAGE = "Your profile was updated elsewhere. Refresh it, then try again.";

function optionalText(value: unknown, maximum: number, fieldName: string) {
  if (typeof value !== "string") throw new Error(`${fieldName} is invalid.`);
  const cleaned = value.trim();
  if (cleaned.length > maximum) throw new Error(`${fieldName} must be ${maximum} characters or fewer.`);
  return cleaned || null;
}

function optionalEmail(value: unknown) {
  const email = optionalText(value, 254, "Personal email");
  if (email && !EMAIL_PATTERN.test(email)) throw new Error("Enter a valid personal email.");
  return email;
}

function optionalDate(value: unknown) {
  if (typeof value !== "string") throw new Error("Date of birth is invalid.");
  const dateValue = value.trim();
  if (!dateValue) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) throw new Error("Date of birth must be a valid date.");

  const [year, month, day] = dateValue.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  const today = new Date();
  const todayDate = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
    || parsed.getTime() > todayDate
  ) {
    throw new Error("Date of birth must be a valid date in the past.");
  }
  return dateValue;
}

function positiveVersion(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(GENERIC_SAVE_ERROR);
  }
  return value;
}

function requiredText(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new Error(GENERIC_LOAD_ERROR);
  return value.trim();
}

function nullableText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function profileVersion(value: unknown) {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(numberValue) || numberValue < 0) throw new Error(GENERIC_LOAD_ERROR);
  return numberValue;
}

function selectedPersonId(value: unknown) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(GENERIC_SELECTED_PROFILE_LOAD_ERROR);
  }
  return value;
}

function selectedProfileVersion(value: unknown, errorMessage: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(errorMessage);
  }
  return value;
}

function toSelfProfile(data: unknown): CurrentEmployeeSelfProfile {
  const rows = Array.isArray(data) ? data : [];
  const row = rows[0] as SelfProfileRpcRow | undefined;
  if (!row || rows.length !== 1 || (row.company_key !== "mam" && row.company_key !== "equipsy")) {
    throw new Error(GENERIC_LOAD_ERROR);
  }

  return {
    name: requiredText(row.full_name),
    title: requiredText(row.position_title),
    company: row.company_key,
    team: nullableText(row.team_name),
    manager: nullableText(row.manager_name),
    workEmail: nullableText(row.work_email),
    personalEmail: nullableText(row.personal_email),
    phone: nullableText(row.phone),
    dateOfBirth: nullableText(row.date_of_birth),
    detailVersion: profileVersion(row.detail_version),
    hasDetail: row.has_detail === true,
  };
}

function toSelectedEmployeeProfile(data: unknown): SelectedEmployeeProfile {
  const rows = Array.isArray(data) ? data : [];
  const row = rows[0] as SelfProfileRpcRow | undefined;
  if (!row || rows.length !== 1 || (row.company_key !== "mam" && row.company_key !== "equipsy")) {
    throw new Error(GENERIC_SELECTED_PROFILE_LOAD_ERROR);
  }

  const detailVersion = typeof row.detail_version === "number"
    ? row.detail_version
    : Number(row.detail_version);
  if (!Number.isSafeInteger(detailVersion) || detailVersion < 0) {
    throw new Error(GENERIC_SELECTED_PROFILE_LOAD_ERROR);
  }

  if (typeof row.full_name !== "string" || !row.full_name.trim()
    || typeof row.position_title !== "string" || !row.position_title.trim()) {
    throw new Error(GENERIC_SELECTED_PROFILE_LOAD_ERROR);
  }

  return {
    personId: selectedPersonId(row.person_id),
    name: row.full_name.trim(),
    title: row.position_title.trim(),
    company: row.company_key,
    team: nullableText(row.team_name),
    manager: nullableText(row.manager_name),
    workEmail: nullableText(row.work_email),
    personalEmail: nullableText(row.personal_email),
    phone: nullableText(row.phone),
    dateOfBirth: nullableText(row.date_of_birth),
    detailVersion,
    hasDetail: row.has_detail === true,
  };
}

async function requireCurrentEmployeeProfile() {
  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new Error("Your session has expired. Sign in again.");
  return supabase;
}

/** Returns only the authenticated employee's own private contact-profile DTO. */
export async function getCurrentEmployeeSelfProfile(): Promise<CurrentEmployeeSelfProfile> {
  const supabase = await requireCurrentEmployeeProfile();
  const { data, error } = await supabase.rpc("get_my_employee_profile");
  if (error) throw new Error(GENERIC_LOAD_ERROR);
  return toSelfProfile(data);
}

/** Updates only the authenticated employee's own phone, personal email, and date of birth. */
export async function updateCurrentEmployeeSelfProfile(
  input: UpdateSelfProfileInput,
): Promise<CurrentEmployeeSelfProfile> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(GENERIC_SAVE_ERROR);

  const supabase = await requireCurrentEmployeeProfile();
  const { data, error } = await supabase.rpc("update_my_employee_profile", {
    p_personal_email: optionalEmail(input.personalEmail),
    p_phone: optionalText(input.phone, 64, "Phone"),
    p_date_of_birth: optionalDate(input.dateOfBirth),
    p_expected_detail_version: positiveVersion(input.detailVersion),
  });

  if (error) {
    const message = error.message.toLocaleLowerCase();
    if (message.includes("version") || message.includes("changed")) {
      throw new Error("Your profile was updated elsewhere. Refresh it, then try again.");
    }
    throw new Error(GENERIC_SAVE_ERROR);
  }

  const profile = toSelfProfile(data);
  revalidatePath("/");
  return profile;
}

/**
 * Returns one selected active employee's profile only when the authenticated
 * actor has the actual HR directory capability. The person ID is validated in
 * this server action and re-authorised in the database RPC; it is never a
 * self-service lookup for ordinary employees.
 */
export async function getSelectedEmployeeProfile(
  personId: string,
): Promise<SelectedEmployeeProfile> {
  const checkedPersonId = selectedPersonId(personId);
  const { supabase } = await requireEmployeeDirectoryManager();
  const { data, error } = await supabase.rpc("get_selected_employee_profile_for_hr", {
    p_person_id: checkedPersonId,
  });

  if (error) throw new Error(GENERIC_SELECTED_PROFILE_LOAD_ERROR);
  return toSelectedEmployeeProfile(data);
}

/**
 * HR-only change-view save path. It can correct only the selected employee's
 * personal email, phone and date of birth; work email and work identity are
 * intentionally absent from the RPC input and remain read-only here.
 */
export async function updateSelectedEmployeeProfile(
  input: UpdateSelectedEmployeeProfileInput,
): Promise<SelectedEmployeeProfile> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(GENERIC_SELECTED_PROFILE_SAVE_ERROR);
  }

  const checkedPersonId = selectedPersonId(input.personId);
  const detailVersion = selectedProfileVersion(input.detailVersion, GENERIC_SELECTED_PROFILE_SAVE_ERROR);
  const { supabase } = await requireEmployeeDirectoryManager();
  const { data, error } = await supabase.rpc("update_selected_employee_profile_for_hr", {
    p_person_id: checkedPersonId,
    p_personal_email: optionalEmail(input.personalEmail),
    p_phone: optionalText(input.phone, 64, "Phone"),
    p_date_of_birth: optionalDate(input.dateOfBirth),
    p_expected_detail_version: detailVersion,
  });

  if (error) {
    const message = error.message.toLocaleLowerCase();
    if (message.includes("version") || message.includes("changed")) {
      throw new Error(STALE_PROFILE_MESSAGE);
    }
    throw new Error(GENERIC_SELECTED_PROFILE_SAVE_ERROR);
  }

  const profile = toSelectedEmployeeProfile(data);
  revalidatePath("/");
  return profile;
}
