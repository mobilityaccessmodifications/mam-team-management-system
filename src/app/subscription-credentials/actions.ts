"use server";

import "server-only";

import { revalidatePath } from "next/cache";

import {
  decryptSubscriptionCredential,
  encryptSubscriptionCredential,
  isSubscriptionCredentialVaultConfigured,
  SubscriptionCredentialVaultConfigurationError,
} from "@/lib/subscription-credential-vault";
import type {
  SubscriptionCredentialAccessGrant,
  SubscriptionCredentialCatalogueItem,
  SubscriptionCredentialDraft,
  SubscriptionCredentialRecord,
} from "@/lib/subscription-credential-types";
import { SUBSCRIPTION_STATUSES, type SubscriptionStatus } from "@/lib/subscription-types";
import { createClient } from "@/lib/supabase/server";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_STATUSES = new Set<string>(SUBSCRIPTION_STATUSES);
const MAXIMUM_GRANTS = 24;
const MAXIMUMS = {
  loginUrl: 2_048,
  username: 512,
  password: 4_096,
  recoveryCodes: 8_192,
  notes: 4_096,
} as const;

type VaultCatalogueRow = {
  subscription_id: string;
  service_name: string;
  plan_name: string | null;
  subscription_status: string;
  credentials_saved: boolean;
};

type VaultCredentialRow = {
  credential_ciphertext: string;
  credential_iv: string;
  credential_auth_tag: string;
  credential_key_version: number | string;
  credential_version: number | string;
};

type VaultGrantRow = {
  person_id: string;
  full_name: string;
  position_title: string;
};

function valueText(value: unknown) {
  return typeof value === "string" ? value : "";
}

function requiredUuid(value: unknown, message: string) {
  const id = valueText(value).trim();
  if (!UUID_PATTERN.test(id)) throw new Error(message);
  return id.toLowerCase();
}

function positiveVersion(value: unknown, allowZero = false) {
  const parsed = typeof value === "number" ? value : Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > Number.MAX_SAFE_INTEGER) {
    throw new Error("The credential record is invalid.");
  }
  return parsed;
}

function inputObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The credential details are invalid.");
  }
  return value as Record<string, unknown>;
}

function credentialText(value: unknown, field: keyof typeof MAXIMUMS, trim = true) {
  if (typeof value !== "string") throw new Error("The credential details are invalid.");
  const result = trim ? value.trim() : value;
  if (result.length > MAXIMUMS[field]) {
    throw new Error("The credential details are too long.");
  }
  return result;
}

function optionalLoginUrl(value: unknown) {
  const raw = credentialText(value, "loginUrl");
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new Error();
    }
    return parsed.toString();
  } catch {
    throw new Error("Enter a valid HTTPS login URL.");
  }
}

function validateCredentialDraft(input: unknown): SubscriptionCredentialDraft {
  const value = inputObject(input);
  const draft: SubscriptionCredentialDraft = {
    loginUrl: optionalLoginUrl(value.loginUrl),
    username: credentialText(value.username, "username"),
    // A password can intentionally begin/end with whitespace, so preserve it.
    password: credentialText(value.password, "password", false),
    recoveryCodes: credentialText(value.recoveryCodes, "recoveryCodes", false),
    notes: credentialText(value.notes, "notes"),
  };

  if (![draft.loginUrl, draft.username, draft.password.trim(), draft.recoveryCodes.trim(), draft.notes].some(Boolean)) {
    throw new Error("Enter at least one credential detail before saving.");
  }
  return draft;
}

function mapCatalogueItem(value: unknown): SubscriptionCredentialCatalogueItem {
  const row = value as Partial<VaultCatalogueRow> | null;
  const subscriptionId = valueText(row?.subscription_id).trim();
  const serviceName = valueText(row?.service_name).trim();
  const status = valueText(row?.subscription_status).trim();
  if (
    !UUID_PATTERN.test(subscriptionId)
    || !serviceName
    || !VALID_STATUSES.has(status)
    || typeof row?.credentials_saved !== "boolean"
  ) {
    throw new Error("Credentials could not be loaded. Refresh and try again.");
  }
  return {
    subscriptionId,
    serviceName,
    planName: valueText(row?.plan_name).trim(),
    status: status as SubscriptionStatus,
    credentialsSaved: row.credentials_saved,
  };
}

function mapGrant(value: unknown): SubscriptionCredentialAccessGrant {
  const row = value as Partial<VaultGrantRow> | null;
  const personId = valueText(row?.person_id).trim();
  const fullName = valueText(row?.full_name).trim();
  const positionTitle = valueText(row?.position_title).trim();
  if (!UUID_PATTERN.test(personId) || !fullName || !positionTitle) {
    throw new Error("Credential access could not be loaded. Refresh and try again.");
  }
  return { personId, fullName, positionTitle };
}

function mapCredentialRow(subscriptionId: string, value: unknown): SubscriptionCredentialRecord {
  const row = value as Partial<VaultCredentialRow> | null;
  const keyVersion = positiveVersion(row?.credential_key_version);
  const credentialVersion = positiveVersion(row?.credential_version);
  const ciphertext = valueText(row?.credential_ciphertext);
  const iv = valueText(row?.credential_iv);
  const authTag = valueText(row?.credential_auth_tag);
  if (!ciphertext || !iv || !authTag) throw new Error("The stored credential is unavailable.");

  const draft = decryptSubscriptionCredential(subscriptionId, {
    ciphertext,
    iv,
    authTag,
    keyVersion,
  });
  return { ...draft, credentialVersion };
}

async function requireVaultManager() {
  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new Error("Your session has expired. Sign in again.");

  const { data: allowed, error: permissionError } = await supabase.rpc("can_manage_subscription_credentials");
  if (permissionError || allowed !== true) {
    throw new Error("You do not have permission to manage subscription credentials.");
  }
  return supabase;
}

async function requireVaultGrantAdministrator() {
  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new Error("Your session has expired. Sign in again.");

  const { data: allowed, error: permissionError } = await supabase.rpc("can_manage_subscription_credential_grants");
  if (permissionError || allowed !== true) {
    throw new Error("You do not have permission to manage credential access.");
  }
  return supabase;
}

function genericVaultError(error: { message?: string } | null, fallback: string) {
  const message = error?.message?.toLowerCase() ?? "";
  if (message.includes("version") || message.includes("changed")) {
    return new Error("These credentials changed. Re-open them, then try again.");
  }
  if (message.includes("permission")) {
    return new Error("You do not have permission to manage subscription credentials.");
  }
  return new Error(fallback);
}

/** Minimal credential-only catalogue. It never includes cost, owner or membership data. */
export async function listSubscriptionCredentialCatalogue(): Promise<SubscriptionCredentialCatalogueItem[]> {
  const supabase = await requireVaultManager();
  const { data, error } = await supabase.rpc("list_subscription_credential_catalogue");
  if (error || !Array.isArray(data)) {
    throw new Error("Credentials could not be loaded. Refresh and try again.");
  }
  try {
    return data.map(mapCatalogueItem);
  } catch {
    throw new Error("Credentials could not be loaded. Refresh and try again.");
  }
}

/** Returns plaintext only after a fresh server-side permission check and explicit user action. */
export async function readSubscriptionCredential(subscriptionId: string): Promise<SubscriptionCredentialRecord | null> {
  const supabase = await requireVaultManager();
  if (!isSubscriptionCredentialVaultConfigured()) {
    throw new Error("The credential vault is not configured yet. Ask a System Admin to finish setup.");
  }
  const id = requiredUuid(subscriptionId, "The subscription record is invalid.");
  const { data, error } = await supabase.rpc("get_subscription_credential", { p_subscription_id: id });
  if (error) throw genericVaultError(error, "The credential could not be opened. Refresh and try again.");
  if (!Array.isArray(data) || data.length === 0) return null;
  if (data.length !== 1) throw new Error("The credential could not be opened. Refresh and try again.");
  try {
    return mapCredentialRow(id, data[0]);
  } catch (reason) {
    if (reason instanceof SubscriptionCredentialVaultConfigurationError) {
      throw new Error("The credential vault key for this record is unavailable. Ask a System Admin to complete key rotation.");
    }
    throw new Error("The credential could not be opened. Refresh and try again.");
  }
}

export async function saveSubscriptionCredential(input: {
  subscriptionId: string;
  credentialVersion: number;
  credential: SubscriptionCredentialDraft;
}): Promise<{ credentialVersion: number }> {
  const supabase = await requireVaultManager();
  const id = requiredUuid(input?.subscriptionId, "The subscription record is invalid.");
  const credentialVersion = positiveVersion(input?.credentialVersion, true);
  const draft = validateCredentialDraft(input?.credential);

  let encrypted;
  try {
    encrypted = encryptSubscriptionCredential(id, draft);
  } catch (reason) {
    if (reason instanceof SubscriptionCredentialVaultConfigurationError) {
      throw new Error("The credential vault is not configured yet. Ask a System Admin to finish setup.");
    }
    throw new Error("The credential could not be secured. Refresh and try again.");
  }

  const { data, error } = await supabase.rpc("save_subscription_credential", {
    p_subscription_id: id,
    p_expected_credential_version: credentialVersion,
    p_credential_ciphertext: encrypted.ciphertext,
    p_credential_iv: encrypted.iv,
    p_credential_auth_tag: encrypted.authTag,
    p_credential_key_version: encrypted.keyVersion,
  });
  if (error || !Array.isArray(data) || data.length !== 1) {
    throw genericVaultError(error, "The credential could not be saved. Refresh and try again.");
  }
  const nextVersion = positiveVersion((data[0] as { credential_version?: unknown }).credential_version);
  revalidatePath("/");
  return { credentialVersion: nextVersion };
}

export async function removeSubscriptionCredential(input: {
  subscriptionId: string;
  credentialVersion: number;
}): Promise<void> {
  const supabase = await requireVaultManager();
  const id = requiredUuid(input?.subscriptionId, "The subscription record is invalid.");
  const credentialVersion = positiveVersion(input?.credentialVersion);
  const { error } = await supabase.rpc("remove_subscription_credential", {
    p_subscription_id: id,
    p_expected_credential_version: credentialVersion,
  });
  if (error) throw genericVaultError(error, "The credential could not be removed. Refresh and try again.");
  revalidatePath("/");
}

/** System Admin-only safe identity list for credential-grant management. */
export async function listSubscriptionCredentialAccessGrants(): Promise<SubscriptionCredentialAccessGrant[]> {
  const supabase = await requireVaultGrantAdministrator();
  const { data, error } = await supabase.rpc("list_subscription_credential_access_grants");
  if (error || !Array.isArray(data)) {
    throw new Error("Credential access could not be loaded. Refresh and try again.");
  }
  try {
    return data.map(mapGrant);
  } catch {
    throw new Error("Credential access could not be loaded. Refresh and try again.");
  }
}

/**
 * System Admin-only candidate list. The database filters out people without a
 * current active portal account, so every displayed selection can be granted.
 */
export async function listSubscriptionCredentialGrantCandidates(): Promise<SubscriptionCredentialAccessGrant[]> {
  const supabase = await requireVaultGrantAdministrator();
  const { data, error } = await supabase.rpc("list_subscription_credential_grant_candidates");
  if (error || !Array.isArray(data)) {
    throw new Error("Credential access could not be loaded. Refresh and try again.");
  }
  try {
    return data.map(mapGrant);
  } catch {
    throw new Error("Credential access could not be loaded. Refresh and try again.");
  }
}

export type SubscriptionCredentialAccessGrantSaveResult =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Replaces explicit vault delegates; active System Admin accounts remain
 * implicit. Server Actions obscure thrown errors in production, so this
 * result-shaped action intentionally returns only safe, action-specific copy.
 */
export async function replaceSubscriptionCredentialAccessGrants(
  personIds: string[],
): Promise<SubscriptionCredentialAccessGrantSaveResult> {
  try {
    const supabase = await requireVaultGrantAdministrator();
    const uniquePersonIds = [...new Set(
      (Array.isArray(personIds) ? personIds : []).map((personId) => requiredUuid(personId, "Choose valid active employees for credential access.")),
    )];
    if (uniquePersonIds.length > MAXIMUM_GRANTS) {
      return { ok: false, message: "Choose no more than 24 credential delegates." };
    }
    const { error } = await supabase.rpc("replace_subscription_credential_access_grants", {
      p_person_ids: uniquePersonIds,
    });
    if (error) {
      const message = error.message.toLowerCase();
      if (message.includes("active portal accounts")) {
        return { ok: false, message: "One or more selected employees no longer have an active portal account. Refresh and choose again." };
      }
      if (message.includes("permission")) {
        return { ok: false, message: "You do not have permission to manage credential access." };
      }
      return { ok: false, message: "Credential access could not be saved. Refresh and try again." };
    }
    revalidatePath("/");
    return { ok: true };
  } catch (reason) {
    if (reason instanceof Error) {
      const message = reason.message;
      if (
        message === "Your session has expired. Sign in again."
        || message === "You do not have permission to manage credential access."
        || message === "Choose valid active employees for credential access."
      ) {
        return { ok: false, message };
      }
    }
    return { ok: false, message: "Credential access could not be saved. Refresh and try again." };
  }
}
