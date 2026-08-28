"use server";

import { createClient } from "@/lib/supabase/server";
import {
  IT_ASSET_TYPES,
  type EmployeeItAsset,
  type ItAssetStatus,
  type ItAssetType,
} from "@/lib/it-asset-types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSET_CODE_PATTERN = /^MAM-IT-\d{6,}$/;
const GENERIC_LOAD_ERROR = "Your devices could not be loaded. Refresh and try again.";
const GENERIC_PREVIEW_LOAD_ERROR = "Employee devices could not be loaded in this preview. Refresh and try again.";
const VALID_TYPES = new Set<string>(IT_ASSET_TYPES);
const VALID_STATUSES = new Set<ItAssetStatus>(["available", "assigned", "repair"]);

type EmployeeItAssetRpcRow = {
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

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function version(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(GENERIC_LOAD_ERROR);
  return parsed;
}

function mapEmployeeItAsset(row: unknown): EmployeeItAsset {
  const value = row as Partial<EmployeeItAssetRpcRow> | null;
  const id = text(value?.asset_id);
  const assetCode = text(value?.asset_code);
  const barcodeValue = text(value?.barcode_value);
  const assetType = text(value?.asset_type);
  const status = text(value?.asset_status);
  const createdAt = text(value?.created_at);

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
    manufacturer: text(value?.manufacturer),
    model: text(value?.model),
    serialNumber: text(value?.serial_number),
    status: status as EmployeeItAsset["status"],
    createdAt,
    version: version(value?.version),
  };
}

function previewPersonId(value: unknown) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(GENERIC_PREVIEW_LOAD_ERROR);
  }
  return value;
}

/**
 * Returns only active devices assigned to the authenticated employee. The
 * server action accepts no person id; the database RPC derives the owner from
 * the current linked portal account and returns a deliberately safe DTO.
 */
export async function listMyItAssets(): Promise<EmployeeItAsset[]> {
  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    throw new Error("Your session has expired. Sign in again.");
  }

  const { data, error } = await supabase.rpc("list_my_it_assets");
  if (error || !Array.isArray(data)) throw new Error(GENERIC_LOAD_ERROR);

  try {
    return data.map(mapEmployeeItAsset);
  } catch {
    throw new Error(GENERIC_LOAD_ERROR);
  }
}

/**
 * Returns the same safe device projection an employee sees for a person
 * selected in the Super Admin Change profile preview. The database rechecks
 * the real System Admin capability and selected active employee in one RPC;
 * this action never exposes the admin asset-custody DTO.
 */
export async function listItAssetsForEmployeePreview(personId: string): Promise<EmployeeItAsset[]> {
  const checkedPersonId = previewPersonId(personId);
  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    throw new Error("Your session has expired. Sign in again.");
  }

  const { data, error } = await supabase.rpc("list_employee_it_assets_for_preview", {
    p_person_id: checkedPersonId,
  });
  if (error || !Array.isArray(data)) throw new Error(GENERIC_PREVIEW_LOAD_ERROR);

  try {
    return data.map(mapEmployeeItAsset);
  } catch {
    throw new Error(GENERIC_PREVIEW_LOAD_ERROR);
  }
}
