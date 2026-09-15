import type { SubscriptionStatus } from "@/lib/subscription-types";

/**
 * Plaintext subscription-service credentials are deliberately transient: they
 * are accepted only by authorised Server Actions and encrypted before storage.
 */
export type SubscriptionCredentialDraft = {
  loginUrl: string;
  accountEmail: string;
  username: string;
  password: string;
  mfaDetails: string;
  recoveryCodes: string;
  licenceKey: string;
  notes: string;
};

export type SubscriptionCredentialRecord = SubscriptionCredentialDraft & {
  credentialVersion: number;
};

/** A minimal catalogue for credential delegates; it contains no cost or member data. */
export type SubscriptionCredentialCatalogueItem = {
  subscriptionId: string;
  serviceName: string;
  planName: string;
  status: SubscriptionStatus;
  credentialsSaved: boolean;
};

/** Safe identity returned only to a System Admin while managing vault access. */
export type SubscriptionCredentialAccessGrant = {
  personId: string;
  fullName: string;
  positionTitle: string;
};
