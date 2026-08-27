"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import {
  IT_ASSET_TYPES,
  type CreateItAssetInput,
  type ItAsset,
  type ItAssetStatus,
  type ItAssetType,
} from "@/lib/it-asset-types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSET_CODE_PATTERN = /^MAM-IT-\d{6,}$/;
const GENERIC_LOAD_ERROR = "IT assets could not be loaded. Refresh and try again.";
const GENERIC_SAVE_ERROR = "The device could not be added. Refresh and try again.";
const VALID_TYPES = new Set<string>(IT_ASSET_TYPES);
const VALID_STATUSES = new Set<ItAssetStatus>(["available", "assigned", "repair", "retired"]);

type ItAssetRpcRow = {
  asset_id: string;
  asset_code: string;
  barcode_value: string;
  asset_type: string;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  asset_status: string;
  created_at: string;
  version: number | string;
};

async function requireItAssetAdministrator() {
  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new Error("Your session has expired. Sign in again.");

  const { data: allowed, error: permissionError } = await supabase.rpc("can_manage_it_assets");
  if (permissionError || allowed !== true) {
    throw new Error("You do not have permission to manage IT assets.");
  }
  return supabase;
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

function validateCreateInput(input: unknown) {
  const value = inputObject(input);
  if (typeof value.assetType !== "string" || !VALID_TYPES.has(value.assetType)) {
    throw new Error("Choose a valid device type.");
  }
  return {
    p_asset_type: value.assetType,
    p_manufacturer: optionalText(value.manufacturer, "Manufacturer", 80),
    p_model: optionalText(value.model, "Model", 120),
    p_serial_number: optionalText(value.serialNumber, "Serial number", 128),
  };
}

function requiredString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function version(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(GENERIC_LOAD_ERROR);
  return parsed;
}

function mapItAsset(row: unknown): ItAsset {
  const value = row as Partial<ItAssetRpcRow> | null;
  const id = requiredString(value?.asset_id);
  const assetCode = requiredString(value?.asset_code);
  const barcodeValue = requiredString(value?.barcode_value);
  const assetType = requiredString(value?.asset_type);
  const status = requiredString(value?.asset_status);
  const createdAt = requiredString(value?.created_at);

  if (
    !UUID_PATTERN.test(id)
    || !ASSET_CODE_PATTERN.test(assetCode)
    || barcodeValue !== assetCode
    || !VALID_TYPES.has(assetType)
    || !VALID_STATUSES.has(status as ItAssetStatus)
    || !createdAt
  ) {
    throw new Error(GENERIC_LOAD_ERROR);
  }

  return {
    id,
    assetCode,
    barcodeValue,
    assetType: assetType as ItAssetType,
    manufacturer: requiredString(value?.manufacturer),
    model: requiredString(value?.model),
    serialNumber: requiredString(value?.serial_number),
    status: status as ItAssetStatus,
    createdAt,
    version: version(value?.version),
  };
}

function mutationError(error: { message?: string } | null) {
  const message = error?.message?.toLocaleLowerCase() ?? "";
  if (message.includes("serial") && message.includes("unique")) {
    return new Error("That serial number is already recorded.");
  }
  if (message.includes("device type") || message.includes("manufacturer") || message.includes("model")) {
    return new Error(error?.message ?? GENERIC_SAVE_ERROR);
  }
  return new Error(GENERIC_SAVE_ERROR);
}

/** Returns the System Admin-only inventory projection; never a secret store. */
export async function listItAssets(): Promise<ItAsset[]> {
  const supabase = await requireItAssetAdministrator();
  const { data, error } = await supabase.rpc("list_it_assets");
  if (error || !Array.isArray(data)) throw new Error(GENERIC_LOAD_ERROR);
  return data.map(mapItAsset);
}

/** Generates the database-owned unique MAM asset code and audit event. */
export async function createItAsset(input: CreateItAssetInput): Promise<ItAsset> {
  const supabase = await requireItAssetAdministrator();
  const values = validateCreateInput(input);
  const { data, error } = await supabase.rpc("create_it_asset", values);
  if (error || !Array.isArray(data)) throw mutationError(error);
  const asset = mapItAsset(data[0]);
  revalidatePath("/");
  return asset;
}
