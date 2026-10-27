export const SUBSCRIPTION_STATUSES = ["active", "paused", "cancelled"] as const;
export const SUBSCRIPTION_COMPANIES = ["mam", "equipsy", "both"] as const;
export type SubscriptionCompany = typeof SUBSCRIPTION_COMPANIES[number];
export function matchesSubscriptionCategory(subscription: Pick<Subscription, "pricingModel" | "company">, pricing: string, company: string) {
  if (pricing && subscription.pricingModel !== pricing) return false;
  if (!company) return true;
  if (company === "unset") return subscription.company === null;
  return subscription.company === company || (company !== "both" && subscription.company === "both");
}
export function subscriptionCompanyLabel(company: SubscriptionCompany | null) {
  return company === "mam" ? "MAM" : company === "equipsy" ? "Equipsy" : company === "both" ? "Both" : "Not set";
}
export function subscriptionCountLabel(subscriptions: Pick<Subscription, "pricingModel">[], total = subscriptions.length) {
  const free = subscriptions.filter((subscription) => subscription.pricingModel === "free").length;
  const paid = subscriptions.length - free;
  const prefix = subscriptions.length === total ? `${total} ${total === 1 ? "subscription" : "subscriptions"}` : `${subscriptions.length} of ${total} subscriptions`;
  return `${prefix} (${free} Free, ${paid} Paid)`;
}
export const SUBSCRIPTION_PRICING_MODELS = ["free", "paid"] as const;
export const SUBSCRIPTION_BILLING_CYCLES = ["monthly", "quarterly", "annual", "other"] as const;

export type SubscriptionStatus = typeof SUBSCRIPTION_STATUSES[number];
export type SubscriptionPricingModel = typeof SUBSCRIPTION_PRICING_MODELS[number];
export type SubscriptionBillingCycle = typeof SUBSCRIPTION_BILLING_CYCLES[number];

/** Minimal active employee identity used only in subscription administration. */
export type SubscriptionPerson = {
  personId: string;
  fullName: string;
  positionTitle: string;
  teamName: string;
  company: "mam" | "equipsy";
};

/** Credential-free management projection for System Admins and managers. */
export type Subscription = {
  company: SubscriptionCompany | null;
  id: string;
  subscriptionCode: string;
  serviceName: string;
  planName: string;
  status: SubscriptionStatus;
  pricingModel: SubscriptionPricingModel;
  billingCycle: SubscriptionBillingCycle | null;
  amountCents: number | null;
  currency: "AUD";
  renewalDate: string | null;
  startDate: string | null;
  seatCount: number | null;
  creditCardUsed: boolean | null;
  creditCardHolder: string | null;
  billingDate: string | null;
  nextBillingOn: string | null;
  lastReviewedOn: string | null;
  nextReviewOn: string;
  responsible: Omit<SubscriptionPerson, "teamName" | "company">;
  memberPersonIds: string[];
  memberNames: string[];
  createdAt: string;
  version: number;
};

/** Safe self-service record: no cost, owner or other employees' access. */
export type EmployeeSubscription = {
  id: string;
  subscriptionCode: string;
  serviceName: string;
  planName: string;
  status: Exclude<SubscriptionStatus, "cancelled">;
  pricingModel: SubscriptionPricingModel;
  billingCycle: SubscriptionBillingCycle | null;
  renewalDate: string | null;
};

export type CreateSubscriptionInput = {
  company: SubscriptionCompany;
  serviceName: string;
  planName?: string;
  pricingModel: SubscriptionPricingModel;
  billingCycle?: SubscriptionBillingCycle;
  amountCents?: number | null;
  renewalDate?: string | null;
  startDate?: string | null;
  seatCount?: number | null;
  creditCardUsed?: boolean | null;
  creditCardHolder?: string | null;
  billingDate?: string | null;
  responsiblePersonId: string;
  memberPersonIds: string[];
};

export type UpdateSubscriptionInput = CreateSubscriptionInput & {
  subscriptionId: string;
  version: number;
  status: SubscriptionStatus;
};

export type ReviewSubscriptionInput = {
  subscriptionId: string;
  version: number;
};

export type SubscriptionTeamAccessInput = ReviewSubscriptionInput & {
  memberPersonIds: string[];
};

export type SubscriptionTeamAccessResult =
  | { ok: true; subscription: Subscription; warning?: string }
  | { ok: false; message: string; refreshRequired?: boolean };

export function subscriptionMonthlyEquivalentCents(subscription: Pick<Subscription, "pricingModel" | "billingCycle" | "amountCents">) {
  if (subscription.pricingModel !== "paid" || subscription.amountCents === null) return null;
  if (subscription.billingCycle === "monthly") return subscription.amountCents;
  if (subscription.billingCycle === "quarterly") return Math.round(subscription.amountCents / 3);
  if (subscription.billingCycle === "annual") return Math.round(subscription.amountCents / 12);
  return null;
}

/** Keeps comparable paid costs first and Free last in both sort directions. */
export function compareSubscriptionMonthlyCost(
  first: Pick<Subscription, "pricingModel" | "billingCycle" | "amountCents">,
  second: Pick<Subscription, "pricingModel" | "billingCycle" | "amountCents">,
  direction: "ascending" | "descending",
) {
  const firstMonthly = subscriptionMonthlyEquivalentCents(first);
  const secondMonthly = subscriptionMonthlyEquivalentCents(second);
  const firstBucket = first.pricingModel === "free" ? 2 : firstMonthly === null ? 1 : 0;
  const secondBucket = second.pricingModel === "free" ? 2 : secondMonthly === null ? 1 : 0;
  if (firstBucket !== secondBucket) return firstBucket - secondBucket;
  if (firstMonthly === null || secondMonthly === null) return 0;
  return direction === "ascending" ? firstMonthly - secondMonthly : secondMonthly - firstMonthly;
}
