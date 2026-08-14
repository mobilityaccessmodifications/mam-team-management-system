"use server";

import { revalidatePath } from "next/cache";

import type { SelfProfileChanges, SelfProfileData } from "@/components/self-profile-menu";
import { createClient } from "@/lib/supabase/server";

type SelfProfileRpcRow = {
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

type UpdateSelfProfileInput = SelfProfileChanges & {
  detailVersion: number;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GENERIC_LOAD_ERROR = "Your profile could not be loaded. Refresh and try again.";
const GENERIC_SAVE_ERROR = "Your profile changes could not be saved. Check the details and try again.";

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
