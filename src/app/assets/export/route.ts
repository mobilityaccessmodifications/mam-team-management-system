import { createClient } from "@/lib/supabase/server";
import { buildXlsxWorkbook } from "@/lib/xlsx-export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type AssetRow = {
  asset_id: string;
  asset_code: string;
  asset_type: string;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  asset_status: string;
  assigned_person_name: string | null;
  assigned_person_title: string | null;
  assigned_person_team: string | null;
  assigned_on: string | null;
  last_returned_on: string | null;
  created_at: string;
};

type CustodyRow = {
  asset_id: string;
  asset_code: string;
  asset_type: string;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  person_name: string;
  person_title: string;
  person_team: string | null;
  assigned_on: string;
  returned_on: string | null;
};

const currentRegisterHeaders = [
  "Asset number",
  "Device type",
  "Manufacturer",
  "Model",
  "Serial number",
  "Status",
  "Current responsible employee",
  "Current job title",
  "Current team",
  "Assigned on",
  "Last hardware returned",
  "Created",
  "Custody history",
] as const;

const custodyHistoryHeaders = [
  "Asset number",
  "Device type",
  "Manufacturer",
  "Model",
  "Serial number",
  "Responsible employee",
  "Job title",
  "Team",
  "Assigned on",
  "Hardware returned on",
  "Custody status",
] as const;

const assetTypeLabels: Record<string, string> = {
  laptop: "Laptop",
  desktop: "Desktop computer",
  iphone: "iPhone",
  ipad: "iPad",
  tablet: "Tablet",
  mobile_phone: "Mobile phone",
  monitor: "Monitor",
  keyboard: "Keyboard",
  mouse: "Mouse",
  sim: "SIM / eSIM",
  other: "Other device",
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function optionalText(value: unknown) {
  return text(value);
}

function titleCase(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function assetTypeLabel(value: string) {
  return assetTypeLabels[value] ?? titleCase(value);
}

function dateOnly(value: string) {
  return value.slice(0, 10);
}

function safeCsvCell(value: string) {
  const protectedValue = /^[\t\r\n ]*[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(protectedValue)
    ? `"${protectedValue.replaceAll('"', '""')}"`
    : protectedValue;
}

function filenameDate() {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function asAssets(rows: unknown): AssetRow[] {
  if (!Array.isArray(rows)) throw new Error("Invalid asset export.");
  return rows.map((row) => {
    const value = row as Partial<AssetRow> | null;
    const assetId = text(value?.asset_id);
    const assetCode = text(value?.asset_code);
    const assetType = text(value?.asset_type);
    const status = text(value?.asset_status);
    if (!assetId || !assetCode || !assetType || !status) throw new Error("Invalid asset export.");
    return {
      asset_id: assetId,
      asset_code: assetCode,
      asset_type: assetType,
      manufacturer: optionalText(value?.manufacturer) || null,
      model: optionalText(value?.model) || null,
      serial_number: optionalText(value?.serial_number) || null,
      asset_status: status,
      assigned_person_name: optionalText(value?.assigned_person_name) || null,
      assigned_person_title: optionalText(value?.assigned_person_title) || null,
      assigned_person_team: optionalText(value?.assigned_person_team) || null,
      assigned_on: optionalText(value?.assigned_on) || null,
      last_returned_on: optionalText(value?.last_returned_on) || null,
      created_at: text(value?.created_at),
    };
  });
}

function asCustody(rows: unknown): CustodyRow[] {
  if (!Array.isArray(rows)) throw new Error("Invalid asset export.");
  return rows.map((row) => {
    const value = row as Partial<CustodyRow> | null;
    const assetId = text(value?.asset_id);
    const assetCode = text(value?.asset_code);
    const assetType = text(value?.asset_type);
    const personName = text(value?.person_name);
    const assignedOn = text(value?.assigned_on);
    if (!assetId || !assetCode || !assetType || !personName || !assignedOn) throw new Error("Invalid asset export.");
    return {
      asset_id: assetId,
      asset_code: assetCode,
      asset_type: assetType,
      manufacturer: optionalText(value?.manufacturer) || null,
      model: optionalText(value?.model) || null,
      serial_number: optionalText(value?.serial_number) || null,
      person_name: personName,
      person_title: text(value?.person_title),
      person_team: optionalText(value?.person_team) || null,
      assigned_on: assignedOn,
      returned_on: optionalText(value?.returned_on) || null,
    };
  });
}

function historyByAsset(history: CustodyRow[]) {
  return history.reduce<Map<string, CustodyRow[]>>((grouped, row) => {
    const entries = grouped.get(row.asset_id) ?? [];
    entries.push(row);
    grouped.set(row.asset_id, entries);
    return grouped;
  }, new Map());
}

function currentRegisterRows(assets: AssetRow[], history: Map<string, CustodyRow[]>) {
  return assets.map((asset) => {
    const ownerHistory = history.get(asset.asset_id) ?? [];
    const historySummary = ownerHistory.map((entry) => (
      `${entry.person_name}: ${dateOnly(entry.assigned_on)} – ${entry.returned_on ? dateOnly(entry.returned_on) : "current"}`
    )).join("; ");
    return [
      asset.asset_code,
      assetTypeLabel(asset.asset_type),
      asset.manufacturer ?? "",
      asset.model ?? "",
      asset.serial_number ?? "",
      titleCase(asset.asset_status),
      asset.assigned_person_name ?? "",
      asset.assigned_person_title ?? "",
      asset.assigned_person_team ?? "",
      asset.assigned_on ? dateOnly(asset.assigned_on) : "",
      asset.last_returned_on ? dateOnly(asset.last_returned_on) : "",
      asset.created_at ? dateOnly(asset.created_at) : "",
      historySummary,
    ];
  });
}

function custodyHistoryRows(history: CustodyRow[]) {
  return history.map((entry) => [
    entry.asset_code,
    assetTypeLabel(entry.asset_type),
    entry.manufacturer ?? "",
    entry.model ?? "",
    entry.serial_number ?? "",
    entry.person_name,
    entry.person_title,
    entry.person_team ?? "",
    dateOnly(entry.assigned_on),
    entry.returned_on ? dateOnly(entry.returned_on) : "",
    entry.returned_on ? "Returned" : "Currently assigned",
  ]);
}

async function loadAssetExportData() {
  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new Error("Not authorised.");

  const { data: allowed, error: permissionError } = await supabase.rpc("can_manage_it_assets");
  if (permissionError || allowed !== true) throw new Error("Not authorised.");

  const [assetsResult, custodyResult] = await Promise.all([
    supabase.rpc("list_it_assets_with_custody"),
    supabase.rpc("list_it_asset_custody_history", { p_asset_id: null }),
  ]);
  if (assetsResult.error || custodyResult.error) throw new Error("Asset export unavailable.");
  return {
    assets: asAssets(assetsResult.data),
    custody: asCustody(custodyResult.data),
  };
}

export async function GET(request: Request) {
  const requestedFormat = new URL(request.url).searchParams.get("format");
  const format = requestedFormat === "xlsx" ? "xlsx" : requestedFormat === "csv" || requestedFormat === null ? "csv" : null;
  if (!format) return new Response("Not found.", { status: 404 });

  try {
    const { assets, custody } = await loadAssetExportData();
    const currentRows = currentRegisterRows(assets, historyByAsset(custody));
    const historyRows = custodyHistoryRows(custody);
    const fileStem = `MAM IT asset register ${filenameDate()}`;

    if (format === "xlsx") {
      const workbook = buildXlsxWorkbook([
        { name: "Current register", rows: [currentRegisterHeaders, ...currentRows] },
        { name: "Custody history", rows: [custodyHistoryHeaders, ...historyRows] },
      ]);
      const workbookBody = new ArrayBuffer(workbook.byteLength);
      new Uint8Array(workbookBody).set(workbook);
      return new Response(workbookBody, {
        headers: {
          "Cache-Control": "private, no-store, max-age=0",
          "Content-Disposition": `attachment; filename="${fileStem}.xlsx"`,
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          Pragma: "no-cache",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    const rows = [currentRegisterHeaders, ...currentRows]
      .map((row) => row.map(safeCsvCell).join(","))
      .join("\r\n");
    return new Response(`\uFEFF${rows}\r\n`, {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Disposition": `attachment; filename="${fileStem}.csv"`,
        "Content-Type": "text/csv; charset=utf-8",
        Pragma: "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("Not authorised.", {
      status: 403,
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
}
