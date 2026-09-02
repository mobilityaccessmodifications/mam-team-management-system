"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import {
  IT_ASSET_TYPES,
  type CreateItAssetInput,
  type ItAsset,
  type ItAssetAssignee,
  type ItAssetCustodyHistory,
  type ItAssetStatus,
  type ItAssetType,
  type ReassignItAssetInput,
  type ReturnItAssetInput,
  type RetireItAssetInput,
} from "@/lib/it-asset-types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSET_CODE_PATTERN = /^MAM-IT-\d{6,}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const GENERIC_LOAD_ERROR = "IT assets could not be loaded. Refresh and try again.";
const GENERIC_SAVE_ERROR = "The device could not be saved. Refresh and try again.";
const VALID_TYPES = new Set<string>(IT_ASSET_TYPES);
const VALID_STATUSES = new Set<ItAssetStatus>(["available", "assigned", "repair", "retired"]);
const VALID_COMPANIES = new Set<ItAssetAssignee["company"]>(["mam", "equipsy"]);

type ItAssetRpcRow = {
  asset_id: string;
  asset_code: string;
  barcode_value: string;
  asset_type: string;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  asset_status: string;
  assigned_person_id: string | null;
  assigned_person_name: string | null;
  assigned_person_title: string | null;
  assigned_person_team: string | null;
  assigned_on?: string | null;
  last_returned_on?: string | null;
  created_at: string;
  version: number | string;
};

type ItAssetCustodyHistoryRpcRow = {
  custody_id: string;
  asset_id: string;
  asset_code: string;
  asset_type: string;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  person_id: string;
  person_name: string;
  person_title: string;
  person_team: string | null;
  assigned_on: string;
  returned_on: string | null;
};

type ItAssetAssigneeRpcRow = {
  person_id: string;
  full_name: string;
  position_title: string;
  team_name: string | null;
  company_key: string;
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

function requiredUuid(value: unknown, message: string) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error(message);
  return value;
}

function validateCreateInput(input: unknown) {
  const value = inputObject(input);
  if (typeof value.assetType !== "string" || !VALID_TYPES.has(value.assetType)) {
    throw new Error("Choose a valid device type.");
  }
  return {
    p_asset_type: value.assetType,
    p_assigned_person_id: requiredUuid(value.assignedPersonId, "Choose the employee responsible for this device."),
    p_manufacturer: optionalText(value.manufacturer, "Manufacturer", 80),
    p_model: optionalText(value.model, "Model", 120),
    p_serial_number: optionalText(value.serialNumber, "Serial number", 128),
  };
}

function validateReassignmentInput(input: unknown) {
  const value = inputObject(input);
  return {
    p_asset_id: requiredUuid(value.assetId, "The device record is invalid."),
    p_assigned_person_id: requiredUuid(value.assignedPersonId, "Choose the employee responsible for this device."),
    p_expected_version: version(value.version),
  };
}

function validateRetirementInput(input: unknown) {
  const value = inputObject(input);
  return {
    p_asset_id: requiredUuid(value.assetId, "The device record is invalid."),
    p_expected_version: version(value.version),
  };
}

function validIsoDate(value: unknown, message: string) {
  const date = requiredString(value);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!ISO_DATE_PATTERN.test(date) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(message);
  }
  return date;
}

function validateReturnInput(input: unknown) {
  const value = inputObject(input);
  return {
    p_asset_id: requiredUuid(value.assetId, "The device record is invalid."),
    p_expected_version: version(value.version),
    p_returned_on: validIsoDate(value.returnedOn, "Choose the date the hardware was returned."),
  };
}

function requiredString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function nullableString(value: unknown) {
  const cleaned = requiredString(value);
  return cleaned || null;
}

function nullableIsoDate(value: unknown, message: string) {
  if (value === undefined || value === null || value === "") return null;
  return validIsoDate(value, message);
}

function version(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("The device record is invalid.");
  return parsed;
}

function mapItAssetAssignee(row: unknown): ItAssetAssignee {
  const value = row as Partial<ItAssetAssigneeRpcRow> | null;
  const personId = requiredString(value?.person_id);
  const fullName = requiredString(value?.full_name);
  const positionTitle = requiredString(value?.position_title);
  const company = requiredString(value?.company_key);

  if (!UUID_PATTERN.test(personId) || !fullName || !positionTitle || !VALID_COMPANIES.has(company as ItAssetAssignee["company"])) {
    throw new Error(GENERIC_LOAD_ERROR);
  }

  return {
    personId,
    fullName,
    positionTitle,
    teamName: requiredString(value?.team_name),
    company: company as ItAssetAssignee["company"],
  };
}

function mapItAsset(row: unknown): ItAsset {
  const value = row as Partial<ItAssetRpcRow> | null;
  const id = requiredString(value?.asset_id);
  const assetCode = requiredString(value?.asset_code);
  const barcodeValue = requiredString(value?.barcode_value);
  const assetType = requiredString(value?.asset_type);
  const status = requiredString(value?.asset_status);
  const createdAt = requiredString(value?.created_at);
  const assignedPersonId = nullableString(value?.assigned_person_id);
  const assignedPersonName = nullableString(value?.assigned_person_name);
  const assignedPersonTitle = nullableString(value?.assigned_person_title);
  const assignedOn = nullableIsoDate(value?.assigned_on, GENERIC_LOAD_ERROR);
  const lastReturnedOn = nullableIsoDate(value?.last_returned_on, GENERIC_LOAD_ERROR);

  if (
    !UUID_PATTERN.test(id)
    || !ASSET_CODE_PATTERN.test(assetCode)
    || barcodeValue !== assetCode
    || !VALID_TYPES.has(assetType)
    || !VALID_STATUSES.has(status as ItAssetStatus)
    || !createdAt
    || (assignedPersonId !== null && (!assignedPersonName || !assignedPersonTitle))
    || (assignedPersonId === null && (assignedPersonName || assignedPersonTitle))
    || (status === "assigned" && (assignedPersonId === null || assignedOn === null))
    || (status !== "assigned" && assignedPersonId !== null)
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
    assignedTo: assignedPersonId === null ? null : {
      personId: assignedPersonId,
      fullName: assignedPersonName!,
      positionTitle: assignedPersonTitle!,
      teamName: requiredString(value?.assigned_person_team),
    },
    assignedOn,
    lastReturnedOn,
    createdAt,
    version: version(value?.version),
  };
}

function mapItAssetCustodyHistory(row: unknown): ItAssetCustodyHistory {
  const value = row as Partial<ItAssetCustodyHistoryRpcRow> | null;
  const id = requiredString(value?.custody_id);
  const assetId = requiredString(value?.asset_id);
  const assetCode = requiredString(value?.asset_code);
  const assetType = requiredString(value?.asset_type);
  const personId = requiredString(value?.person_id);
  const personName = requiredString(value?.person_name);
  const personTitle = requiredString(value?.person_title);
  const assignedOn = validIsoDate(value?.assigned_on, GENERIC_LOAD_ERROR);
  const returnedOn = nullableIsoDate(value?.returned_on, GENERIC_LOAD_ERROR);

  if (
    !UUID_PATTERN.test(id)
    || !UUID_PATTERN.test(assetId)
    || !ASSET_CODE_PATTERN.test(assetCode)
    || !VALID_TYPES.has(assetType)
    || !UUID_PATTERN.test(personId)
    || !personName
    || !personTitle
  ) {
    throw new Error(GENERIC_LOAD_ERROR);
  }

  return {
    id,
    assetId,
    assetCode,
    assetType: assetType as ItAssetType,
    manufacturer: requiredString(value?.manufacturer),
    model: requiredString(value?.model),
    serialNumber: requiredString(value?.serial_number),
    person: {
      personId,
      fullName: personName,
      positionTitle: personTitle,
      teamName: requiredString(value?.person_team),
    },
    assignedOn,
    returnedOn,
  };
}

function mutationError(error: { message?: string } | null, fallback = GENERIC_SAVE_ERROR) {
  const rawMessage = error?.message ?? "";
  const message = rawMessage.toLocaleLowerCase();
  if (message.includes("serial") && message.includes("unique")) {
    return new Error("That serial number is already recorded.");
  }
  if (message.includes("version") || message.includes("changed")) {
    return new Error("This device has changed. Refresh it, then try again.");
  }
  if (message.includes("active employee") || message.includes("responsible for this device") || message.includes("choose the employee")) {
    return new Error("Choose an active employee responsible for this device.");
  }
  if (message.includes("removed device") || message.includes("already been removed")) {
    return new Error("This device has already been removed. Refresh the register.");
  }
  if (message.includes("returned date") || message.includes("hardware was returned")) {
    return new Error(rawMessage || "Choose the date the hardware was returned.");
  }
  if (message.includes("not currently assigned")) {
    return new Error("This device is not currently assigned. Refresh the register.");
  }
  if (message.includes("device type") || message.includes("manufacturer") || message.includes("model")) {
    return new Error(rawMessage);
  }
  return new Error(fallback);
}

/** Returns the System Admin-only inventory projection; never a secret store. */
export async function listItAssets(): Promise<ItAsset[]> {
  const supabase = await requireItAssetAdministrator();
  const { data, error } = await supabase.rpc("list_it_assets_with_custody");
  if (error || !Array.isArray(data)) throw new Error(GENERIC_LOAD_ERROR);
  return data.map(mapItAsset);
}

/** Returns only the safe employee identity fields required for device custody. */
export async function listItAssetAssignees(): Promise<ItAssetAssignee[]> {
  const supabase = await requireItAssetAdministrator();
  const { data, error } = await supabase.rpc("list_it_asset_assignees");
  if (error || !Array.isArray(data)) throw new Error(GENERIC_LOAD_ERROR);
  return data.map(mapItAssetAssignee);
}

/** Returns the System Admin-only current devices for one HR directory record. */
export async function listItAssetsForEmployee(personId: string): Promise<ItAsset[]> {
  const supabase = await requireItAssetAdministrator();
  const validPersonId = requiredUuid(personId, "The employee record is invalid.");
  const { data, error } = await supabase.rpc("list_it_assets_for_employee_with_custody", {
    p_person_id: validPersonId,
  });
  if (error || !Array.isArray(data)) throw new Error(GENERIC_LOAD_ERROR);
  return data.map(mapItAsset);
}

/** Returns the durable, System Admin-only owner timeline for one device. */
export async function listItAssetCustodyHistory(assetId: string): Promise<ItAssetCustodyHistory[]> {
  const supabase = await requireItAssetAdministrator();
  const validAssetId = requiredUuid(assetId, "The device record is invalid.");
  const { data, error } = await supabase.rpc("list_it_asset_custody_history", {
    p_asset_id: validAssetId,
  });
  if (error || !Array.isArray(data)) throw new Error(GENERIC_LOAD_ERROR);
  return data.map(mapItAssetCustodyHistory);
}

async function loadItAssetById(supabase: Awaited<ReturnType<typeof createClient>>, assetId: string) {
  const { data, error } = await supabase.rpc("get_it_asset_with_custody", {
    p_asset_id: assetId,
  });
  if (error || !Array.isArray(data) || data.length !== 1) throw new Error(GENERIC_LOAD_ERROR);
  return mapItAsset(data[0]);
}

/** Generates the database-owned unique MAM asset code and records its custodian. */
export async function createItAsset(input: CreateItAssetInput): Promise<ItAsset> {
  const supabase = await requireItAssetAdministrator();
  const values = validateCreateInput(input);
  const { data, error } = await supabase.rpc("create_it_asset", values);
  if (error || !Array.isArray(data)) throw mutationError(error, "The device could not be added. Refresh and try again.");
  const assetId = requiredUuid((data[0] as Partial<ItAssetRpcRow> | undefined)?.asset_id, GENERIC_SAVE_ERROR);
  const asset = await loadItAssetById(supabase, assetId);
  revalidatePath("/");
  return asset;
}

/** Changes an existing device's accountable employee with database version checks. */
export async function reassignItAsset(input: ReassignItAssetInput): Promise<ItAsset> {
  const supabase = await requireItAssetAdministrator();
  const values = validateReassignmentInput(input);
  const { data, error } = await supabase.rpc("reassign_it_asset", values);
  if (error || !Array.isArray(data)) throw mutationError(error);
  const assetId = requiredUuid((data[0] as Partial<ItAssetRpcRow> | undefined)?.asset_id, GENERIC_SAVE_ERROR);
  const asset = await loadItAssetById(supabase, assetId);
  revalidatePath("/");
  return asset;
}

/** Closes the current custody period without deleting the asset or its history. */
export async function returnItAsset(input: ReturnItAssetInput): Promise<ItAsset> {
  const supabase = await requireItAssetAdministrator();
  const values = validateReturnInput(input);
  const { data, error } = await supabase.rpc("return_it_asset", values);
  if (error || !Array.isArray(data)) {
    throw mutationError(error, "The hardware return could not be recorded. Refresh and try again.");
  }
  const asset = mapItAsset(data[0]);
  revalidatePath("/");
  return asset;
}

/** Hides an incorrect entry from the active register while retaining its audit history. */
export async function retireItAsset(input: RetireItAssetInput): Promise<ItAsset> {
  const supabase = await requireItAssetAdministrator();
  const values = validateRetirementInput(input);
  const { data, error } = await supabase.rpc("retire_it_asset", values);
  if (error || !Array.isArray(data)) throw mutationError(error, "The device could not be removed. Refresh and try again.");
  const asset = mapItAsset(data[0]);
  revalidatePath("/");
  return asset;
}
