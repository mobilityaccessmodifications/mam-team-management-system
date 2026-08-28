export const SUBSCRIPTION_STATUSES = ["active", "paused", "cancelled"] as const;
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
  serviceName: string;
  planName?: string;
  pricingModel: SubscriptionPricingModel;
  billingCycle?: SubscriptionBillingCycle;
  amountCents?: number | null;
  renewalDate?: string | null;
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
