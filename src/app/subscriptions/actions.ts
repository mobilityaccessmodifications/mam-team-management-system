"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import {
  SUBSCRIPTION_BILLING_CYCLES,
  SUBSCRIPTION_PRICING_MODELS,
  SUBSCRIPTION_STATUSES,
  type CreateSubscriptionInput,
  type ReviewSubscriptionInput,
  type Subscription,
  type SubscriptionBillingCycle,
  type SubscriptionPerson,
  type SubscriptionPricingModel,
  type SubscriptionStatus,
  type UpdateSubscriptionInput,
} from "@/lib/subscription-types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SUBSCRIPTION_CODE_PATTERN = /^MAM-SUB-\d{6,}$/;
const VALID_STATUSES = new Set<string>(SUBSCRIPTION_STATUSES);
const VALID_PRICING_MODELS = new Set<string>(SUBSCRIPTION_PRICING_MODELS);
const VALID_BILLING_CYCLES = new Set<string>(SUBSCRIPTION_BILLING_CYCLES);
const GENERIC_LOAD_ERROR = "Subscriptions could not be loaded. Refresh and try again.";
const GENERIC_SAVE_ERROR = "The subscription could not be saved. Refresh and try again.";

type SubscriptionRpcRow = {
  subscription_id: string;
  subscription_code: string;
  service_name: string;
  plan_name: string | null;
  subscription_status: string;
  pricing_model: string;
  billing_cycle: string | null;
  amount_cents: number | string | null;
  currency_code: string;
  renewal_date: string | null;
  next_review_on: string;
  responsible_person_id: string;
  responsible_person_name: string;
  responsible_person_title: string;
  member_person_ids: string[] | null;
  member_names: string[] | null;
  created_at: string;
  version: number | string;
};

type SubscriptionPersonRpcRow = {
  person_id: string;
  full_name: string;
  position_title: string;
  team_name: string | null;
  company_key: string;
};

async function requireSubscriptionViewer() {
  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new Error("Your session has expired. Sign in again.");

  const { data: allowed, error: permissionError } = await supabase.rpc("can_view_subscription_register");
  if (permissionError || allowed !== true) {
    throw new Error("You do not have permission to view subscriptions.");
  }
  return supabase;
}

async function requireSubscriptionAdministrator() {
  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new Error("Your session has expired. Sign in again.");

  const { data: allowed, error: permissionError } = await supabase.rpc("can_manage_subscriptions");
  if (permissionError || allowed !== true) {
    throw new Error("You do not have permission to manage subscriptions.");
  }
  return supabase;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function optionalText(value: unknown, label: string, maximum: number) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  const cleaned = value.trim();
  if (cleaned.length > maximum) throw new Error(`${label} must be ${maximum} characters or fewer.`);
  return cleaned || null;
}

function inputObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(GENERIC_SAVE_ERROR);
  return value as Record<string, unknown>;
}

function requiredUuid(value: unknown, message: string) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error(message);
  return value;
}

function requiredVersion(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("The subscription record is invalid.");
  return parsed;
}

function optionalDate(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function optionalAmountCents(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 100_000_000) {
    throw new Error("Enter a valid amount.");
  }
  return parsed;
}

function personIds(value: unknown) {
  if (!Array.isArray(value) || value.length > 250) throw new Error("Choose valid employees for subscription access.");
  const unique = [...new Set(value.map((personId) => requiredUuid(personId, "Choose valid employees for subscription access.")))];
  return unique;
}

function validateSubscriptionInput(input: unknown, includeStatus: boolean) {
  const value = inputObject(input);
  const serviceName = optionalText(value.serviceName, "Service name", 160);
  if (!serviceName) throw new Error("Enter the service name.");
  const pricingModel = text(value.pricingModel);
  if (!VALID_PRICING_MODELS.has(pricingModel)) throw new Error("Choose whether this subscription is free or paid.");
  const billingCycle = pricingModel === "paid" ? text(value.billingCycle) : null;
  const amountCents = pricingModel === "paid" ? optionalAmountCents(value.amountCents) : null;
  if (pricingModel === "paid" && (!billingCycle || !VALID_BILLING_CYCLES.has(billingCycle) || amountCents === null)) {
    throw new Error("Paid subscriptions need a billing cycle and an amount.");
  }

  return {
    p_service_name: serviceName,
    p_plan_name: optionalText(value.planName, "Plan name", 160),
    ...(includeStatus ? { p_subscription_status: validStatus(value.status) } : {}),
    p_pricing_model: pricingModel as SubscriptionPricingModel,
    p_billing_cycle: billingCycle as SubscriptionBillingCycle | null,
    p_amount_cents: amountCents,
    p_renewal_date: optionalDate(value.renewalDate, "Renewal date"),
    p_responsible_person_id: requiredUuid(value.responsiblePersonId, "Choose the employee responsible for this subscription."),
    p_member_person_ids: personIds(value.memberPersonIds),
  };
}

function validStatus(value: unknown) {
  const status = text(value);
  if (!VALID_STATUSES.has(status)) throw new Error("Choose a valid subscription status.");
  return status as SubscriptionStatus;
}

function nullableText(value: unknown) {
  const result = text(value);
  return result || null;
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function mapSubscriptionPerson(row: unknown): SubscriptionPerson {
  const value = row as Partial<SubscriptionPersonRpcRow> | null;
  const personId = text(value?.person_id);
  const fullName = text(value?.full_name);
  const positionTitle = text(value?.position_title);
  const company = text(value?.company_key);
  if (!UUID_PATTERN.test(personId) || !fullName || !positionTitle || (company !== "mam" && company !== "equipsy")) {
    throw new Error(GENERIC_LOAD_ERROR);
  }
  return {
    personId,
    fullName,
    positionTitle,
    teamName: text(value?.team_name),
    company,
  };
}

function mapSubscription(row: unknown): Subscription {
  const value = row as Partial<SubscriptionRpcRow> | null;
  const id = text(value?.subscription_id);
  const subscriptionCode = text(value?.subscription_code);
  const serviceName = text(value?.service_name);
  const status = text(value?.subscription_status);
  const pricingModel = text(value?.pricing_model);
  const billingCycle = nullableText(value?.billing_cycle);
  const currency = text(value?.currency_code);
  const responsiblePersonId = text(value?.responsible_person_id);
  const responsiblePersonName = text(value?.responsible_person_name);
  const responsiblePersonTitle = text(value?.responsible_person_title);
  const nextReviewOn = text(value?.next_review_on);
  const createdAt = text(value?.created_at);
  const amountRaw = value?.amount_cents;
  const amountCents = amountRaw === null || amountRaw === undefined ? null : Number(amountRaw);
  const renewalDate = nullableText(value?.renewal_date);
  const version = Number(value?.version);
  const memberPersonIds = stringArray(value?.member_person_ids);
  const memberNames = stringArray(value?.member_names);

  if (
    !UUID_PATTERN.test(id)
    || !SUBSCRIPTION_CODE_PATTERN.test(subscriptionCode)
    || !serviceName
    || !VALID_STATUSES.has(status)
    || !VALID_PRICING_MODELS.has(pricingModel)
    || (billingCycle !== null && !VALID_BILLING_CYCLES.has(billingCycle))
    || (pricingModel === "free" && (billingCycle !== null || amountCents !== null))
    || (pricingModel === "paid" && (amountCents === null || !billingCycle || !Number.isSafeInteger(amountCents) || amountCents < 0))
    || currency !== "AUD"
    || (renewalDate !== null && !ISO_DATE_PATTERN.test(renewalDate))
    || !ISO_DATE_PATTERN.test(nextReviewOn)
    || !UUID_PATTERN.test(responsiblePersonId)
    || !responsiblePersonName
    || !responsiblePersonTitle
    || !createdAt
    || !Number.isSafeInteger(version)
    || version < 1
    || memberPersonIds.some((personId) => !UUID_PATTERN.test(personId))
    || memberPersonIds.length !== memberNames.length
  ) {
    throw new Error(GENERIC_LOAD_ERROR);
  }

  return {
    id,
    subscriptionCode,
    serviceName,
    planName: text(value?.plan_name),
    status: status as SubscriptionStatus,
    pricingModel: pricingModel as SubscriptionPricingModel,
    billingCycle: billingCycle as SubscriptionBillingCycle | null,
    amountCents,
    currency: "AUD",
    renewalDate,
    nextReviewOn,
    responsible: {
      personId: responsiblePersonId,
      fullName: responsiblePersonName,
      positionTitle: responsiblePersonTitle,
    },
    memberPersonIds,
    memberNames,
    createdAt,
    version,
  };
}

function mutationError(error: { message?: string } | null, fallback = GENERIC_SAVE_ERROR) {
  const message = (error?.message ?? "").toLocaleLowerCase();
  if (message.includes("version") || message.includes("changed")) {
    return new Error("This subscription has changed. Refresh it, then try again.");
  }
  if (message.includes("active employee") || message.includes("responsible") || message.includes("subscription access")) {
    return new Error("Choose active employees for the owner and access list.");
  }
  if (message.includes("paid subscriptions") || message.includes("billing cycle") || message.includes("valid amount")) {
    return new Error("Paid subscriptions need a billing cycle and an amount.");
  }
  if (message.includes("service name") || message.includes("plan name") || message.includes("subscription status")) {
    return new Error(error?.message ?? fallback);
  }
  return new Error(fallback);
}

/** Credential-free management register for System Admins and managers. */
export async function listSubscriptions(): Promise<Subscription[]> {
  const supabase = await requireSubscriptionViewer();
  const { data, error } = await supabase.rpc("list_subscriptions");
  if (error || !Array.isArray(data)) throw new Error(GENERIC_LOAD_ERROR);
  try {
    return data.map(mapSubscription);
  } catch {
    throw new Error(GENERIC_LOAD_ERROR);
  }
}

/** Active employee selector for System Admin-only subscription administration. */
export async function listSubscriptionPeople(): Promise<SubscriptionPerson[]> {
  const supabase = await requireSubscriptionAdministrator();
  const { data, error } = await supabase.rpc("list_subscription_people");
  if (error || !Array.isArray(data)) throw new Error(GENERIC_LOAD_ERROR);
  try {
    return data.map(mapSubscriptionPerson);
  } catch {
    throw new Error(GENERIC_LOAD_ERROR);
  }
}

export async function createSubscription(input: CreateSubscriptionInput): Promise<Subscription> {
  const supabase = await requireSubscriptionAdministrator();
  const values = validateSubscriptionInput(input, false);
  const { data, error } = await supabase.rpc("create_subscription", values);
  if (error || !Array.isArray(data)) throw mutationError(error, "The subscription could not be added. Refresh and try again.");
  const subscription = mapSubscription(data[0]);
  revalidatePath("/");
  return subscription;
}

export async function updateSubscription(input: UpdateSubscriptionInput): Promise<Subscription> {
  const supabase = await requireSubscriptionAdministrator();
  const values = validateSubscriptionInput(input, true);
  const { data, error } = await supabase.rpc("update_subscription", {
    p_subscription_id: requiredUuid(input.subscriptionId, "The subscription record is invalid."),
    p_expected_version: requiredVersion(input.version),
    ...values,
  });
  if (error || !Array.isArray(data)) throw mutationError(error);
  const subscription = mapSubscription(data[0]);
  revalidatePath("/");
  return subscription;
}

/** Records the quarterly review and lets the database set the next date. */
export async function markSubscriptionReviewed(input: ReviewSubscriptionInput): Promise<Subscription> {
  const supabase = await requireSubscriptionAdministrator();
  const { data, error } = await supabase.rpc("mark_subscription_reviewed", {
    p_subscription_id: requiredUuid(input.subscriptionId, "The subscription record is invalid."),
    p_expected_version: requiredVersion(input.version),
  });
  if (error || !Array.isArray(data)) throw mutationError(error, "The review could not be recorded. Refresh and try again.");
  const subscription = mapSubscription(data[0]);
  revalidatePath("/");
  return subscription;
}
