"use server";

import { createClient } from "@/lib/supabase/server";
import {
  SUBSCRIPTION_BILLING_CYCLES,
  SUBSCRIPTION_PRICING_MODELS,
  SUBSCRIPTION_STATUSES,
  type EmployeeSubscription,
  type SubscriptionBillingCycle,
  type SubscriptionPricingModel,
} from "@/lib/subscription-types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBSCRIPTION_CODE_PATTERN = /^MAM-SUB-\d{6,}$/;
const GENERIC_LOAD_ERROR = "Your subscriptions could not be loaded. Refresh and try again.";
const GENERIC_PREVIEW_LOAD_ERROR = "Employee subscriptions could not be loaded in this preview. Refresh and try again.";
const VALID_STATUSES = new Set<string>(SUBSCRIPTION_STATUSES);
const VALID_PRICING_MODELS = new Set<string>(SUBSCRIPTION_PRICING_MODELS);
const VALID_BILLING_CYCLES = new Set<string>(SUBSCRIPTION_BILLING_CYCLES);

type EmployeeSubscriptionRpcRow = {
  subscription_id: string;
  subscription_code: string;
  service_name: string;
  plan_name: string | null;
  subscription_status: string;
  pricing_model: string;
  billing_cycle: string | null;
  renewal_date: string | null;
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function nullableText(value: unknown) {
  const result = text(value);
  return result || null;
}

function previewPersonId(value: unknown) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(GENERIC_PREVIEW_LOAD_ERROR);
  }
  return value;
}

function mapEmployeeSubscription(row: unknown): EmployeeSubscription {
  const value = row as Partial<EmployeeSubscriptionRpcRow> | null;
  const id = text(value?.subscription_id);
  const subscriptionCode = text(value?.subscription_code);
  const serviceName = text(value?.service_name);
  const status = text(value?.subscription_status);
  const pricingModel = text(value?.pricing_model);
  const billingCycle = nullableText(value?.billing_cycle);
  const renewalDate = nullableText(value?.renewal_date);

  if (
    !UUID_PATTERN.test(id)
    || !SUBSCRIPTION_CODE_PATTERN.test(subscriptionCode)
    || !serviceName
    || !VALID_STATUSES.has(status)
    || status === "cancelled"
    || !VALID_PRICING_MODELS.has(pricingModel)
    || (billingCycle !== null && !VALID_BILLING_CYCLES.has(billingCycle))
    || (pricingModel === "free" && billingCycle !== null)
    || (pricingModel === "paid" && billingCycle === null)
    || (renewalDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(renewalDate))
  ) {
    throw new Error(GENERIC_LOAD_ERROR);
  }

  return {
    id,
    subscriptionCode,
    serviceName,
    planName: text(value?.plan_name),
    status: status as Exclude<EmployeeSubscription["status"], "cancelled">,
    pricingModel: pricingModel as SubscriptionPricingModel,
    billingCycle: billingCycle as SubscriptionBillingCycle | null,
    renewalDate,
  };
}

/**
 * Returns only the authenticated employee's active subscription assignments.
 * The RPC derives their linked person from auth.uid(), so no browser-selected
 * employee identifier can widen the result.
 */
export async function listMySubscriptions(): Promise<EmployeeSubscription[]> {
  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new Error("Your session has expired. Sign in again.");

  const { data, error } = await supabase.rpc("list_my_subscriptions");
  if (error || !Array.isArray(data)) throw new Error(GENERIC_LOAD_ERROR);
  try {
    return data.map(mapEmployeeSubscription);
  } catch {
    throw new Error(GENERIC_LOAD_ERROR);
  }
}

/**
 * Same self-safe projection used by System Admin Change profile previews. The
 * database checks both the real System Admin session and active target.
 */
export async function listEmployeeSubscriptionsForPreview(personId: string): Promise<EmployeeSubscription[]> {
  const checkedPersonId = previewPersonId(personId);
  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new Error("Your session has expired. Sign in again.");

  const { data, error } = await supabase.rpc("list_employee_subscriptions_for_preview", {
    p_person_id: checkedPersonId,
  });
  if (error || !Array.isArray(data)) throw new Error(GENERIC_PREVIEW_LOAD_ERROR);
  try {
    return data.map(mapEmployeeSubscription);
  } catch {
    throw new Error(GENERIC_PREVIEW_LOAD_ERROR);
  }
}
