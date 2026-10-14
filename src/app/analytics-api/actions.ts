"use server";

import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AnalyticsApiKey = {
  id: string;
  keyPrefix: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
};

export type AnalyticsApiActionResult =
  | { ok: true; key?: string }
  | { ok: false; message: string };

function valueText(value: unknown) {
  return typeof value === "string" ? value : "";
}

function mapKey(value: unknown): AnalyticsApiKey {
  const row = value as Record<string, unknown> | null;
  const id = valueText(row?.id).trim();
  const keyPrefix = valueText(row?.key_prefix).trim();
  const label = valueText(row?.label).trim();
  const createdAt = valueText(row?.created_at).trim();
  const revokedAt = row?.revoked_at === null ? null : valueText(row?.revoked_at).trim() || null;
  const lastUsedAt = row?.last_used_at === null ? null : valueText(row?.last_used_at).trim() || null;
  if (!UUID_PATTERN.test(id) || !keyPrefix || !label || !createdAt) {
    throw new Error("Analytics API access could not be loaded. Refresh and try again.");
  }
  return { id, keyPrefix, label, createdAt, revokedAt, lastUsedAt };
}

async function requireAnalyticsApiManager() {
  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new Error("Your session has expired. Sign in again.");

  const { data: allowed, error: permissionError } = await supabase.rpc("can_manage_analytics_api");
  if (permissionError?.code === "42501" || (!permissionError && allowed === false)) {
    throw new Error("You do not have permission to manage the Analytics API.");
  }
  if (permissionError || allowed !== true) throw new Error("Analytics API access could not be loaded. Refresh and try again.");
  return supabase;
}

function actionFailure(reason: unknown, fallback: string): AnalyticsApiActionResult {
  if (reason instanceof Error) {
    if (
      reason.message === "Your session has expired. Sign in again."
      || reason.message === "You do not have permission to manage the Analytics API."
    ) {
      return { ok: false, message: reason.message };
    }
  }
  return { ok: false, message: fallback };
}

/** Safe lifecycle metadata only. A raw key is never returned from this read. */
export async function listAnalyticsApiKeys(): Promise<AnalyticsApiKey[]> {
  const supabase = await requireAnalyticsApiManager();
  const { data, error } = await supabase.rpc("list_analytics_api_keys");
  if (error || !Array.isArray(data)) {
    throw new Error("Analytics API access could not be loaded. Refresh and try again.");
  }
  try {
    return data.map(mapKey);
  } catch {
    throw new Error("Analytics API access could not be loaded. Refresh and try again.");
  }
}

/**
 * Generates a bearer token only in server memory. The DB receives its SHA-256
 * hash; this response is the sole opportunity for the browser to copy it.
 */
export async function createAnalyticsApiKey(labelInput: string): Promise<AnalyticsApiActionResult> {
  try {
    const label = valueText(labelInput).trim();
    if (!label || label.length > 80) {
      return { ok: false, message: "Enter a label of up to 80 characters." };
    }

    const supabase = await requireAnalyticsApiManager();
    const rawKey = `mam_analytics_${randomBytes(32).toString("base64url")}`;
    const keyPrefix = rawKey.slice(0, "mam_analytics_".length + 12);
    const keyHash = createHash("sha256").update(rawKey, "utf8").digest("hex");
    const { error } = await supabase.rpc("create_analytics_api_key_record", {
      p_key_hash: keyHash,
      p_key_prefix: keyPrefix,
      p_label: label,
    });
    if (error) return { ok: false, message: "Analytics API access could not be saved. Refresh and try again." };

    revalidatePath("/");
    return { ok: true, key: rawKey };
  } catch (reason) {
    return actionFailure(reason, "Analytics API access could not be saved. Refresh and try again.");
  }
}

export async function revokeAnalyticsApiKey(keyIdInput: string): Promise<AnalyticsApiActionResult> {
  try {
    const keyId = valueText(keyIdInput).trim().toLowerCase();
    if (!UUID_PATTERN.test(keyId)) {
      return { ok: false, message: "The Analytics API key is invalid." };
    }

    const supabase = await requireAnalyticsApiManager();
    const { data, error } = await supabase.rpc("revoke_analytics_api_key", { p_key_id: keyId });
    if (error || data !== true) {
      return { ok: false, message: "Analytics API access could not be revoked. Refresh and try again." };
    }

    revalidatePath("/");
    return { ok: true };
  } catch (reason) {
    return actionFailure(reason, "Analytics API access could not be revoked. Refresh and try again.");
  }
}
