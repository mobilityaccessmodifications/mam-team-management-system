"use server";

import "server-only";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type OnboardingCredentialReview = {
  deliveryId: string;
  employeeName: string;
  company: "mam" | "equipsy";
  status: "needs_review";
  reviewCode: string | null;
  hasClaimedLogin: boolean;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ReviewFailure = { ok: false; message: string };
export type ReviewListResult = { ok: true; reviews: OnboardingCredentialReview[] } | ReviewFailure;
export type ReviewCancellationResult = { ok: true; committed: true; message: string } | ReviewFailure;

const deniedMessage = "Only System Admin may review onboarding credentials.";
const refreshMessage = "The review changed or cannot be cancelled. Refresh the list before continuing.";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && timestampPattern.test(value) && Number.isFinite(Date.parse(value));
}

async function authorizedClient() {
  const client = await createClient();
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return null;
  const permission = await client.rpc("can_change_employee_view");
  return !permission.error && permission.data === true ? client : null;
}

function reviewRow(value: unknown): OnboardingCredentialReview | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.delivery_id !== "string" || !uuidPattern.test(row.delivery_id)
    || typeof row.employee_name !== "string"
    || (row.company_key !== "mam" && row.company_key !== "equipsy")
    || row.status !== "needs_review"
    || (row.review_code !== null && typeof row.review_code !== "string")
    || typeof row.has_claimed_login !== "boolean"
    || (row.due_date !== null && (typeof row.due_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.due_date)))
    || !isTimestamp(row.created_at) || !isTimestamp(row.updated_at)) return null;
  return {
    deliveryId: row.delivery_id,
    employeeName: row.employee_name,
    company: row.company_key,
    status: row.status,
    reviewCode: row.review_code,
    hasClaimedLogin: row.has_claimed_login,
    dueDate: row.due_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listOnboardingCredentialReviews(): Promise<ReviewListResult> {
  try {
    const client = await authorizedClient();
    if (!client) return { ok: false, message: deniedMessage };
    const { data, error } = await client.rpc("list_onboarding_credential_reviews");
    if (error || !Array.isArray(data)) return { ok: false, message: "Unable to load onboarding reviews. Refresh and try again." };
    const reviews = data.map(reviewRow);
    if (reviews.some((row) => row === null)) return { ok: false, message: "Unable to load onboarding reviews. Refresh and try again." };
    return { ok: true, reviews: reviews as OnboardingCredentialReview[] };
  } catch {
    return { ok: false, message: "Unable to load onboarding reviews. Refresh and try again." };
  }
}

export async function cancelOnboardingCredentialReview(input: unknown): Promise<ReviewCancellationResult> {
  try {
    const client = await authorizedClient();
    if (!client) return { ok: false, message: deniedMessage };
    if (!input || typeof input !== "object") return { ok: false, message: refreshMessage };
    const { deliveryId, updatedAt } = input as Record<string, unknown>;
    if (typeof deliveryId !== "string" || !uuidPattern.test(deliveryId) || !isTimestamp(updatedAt)) {
      return { ok: false, message: refreshMessage };
    }
    const { data, error } = await client.rpc("cancel_onboarding_credential_review", {
      p_delivery_id: deliveryId,
      p_expected_updated_at: updatedAt,
    });
    if (error || data !== true) return { ok: false, message: error?.code === "42501" ? deniedMessage : refreshMessage };
  } catch {
    return { ok: false, message: "Cancellation could not be confirmed. Refresh the list before continuing." };
  }
  try {
    revalidatePath("/onboarding-review");
    revalidatePath("/");
  } catch {
    return { ok: true, committed: true, message: "Cancelled. Refresh to load the latest records." };
  }
  return { ok: true, committed: true, message: "Cancelled." };
}
