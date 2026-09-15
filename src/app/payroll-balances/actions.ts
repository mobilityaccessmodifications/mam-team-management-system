"use server";

import "server-only";

import { revalidatePath } from "next/cache";

import { parsePayrollBalanceFiles } from "@/lib/payroll-balance-import";
import type {
  PayrollImportAccessPerson,
  PayrollImportAccessWorkspace,
  PayrollImportBatch,
  PayrollImportBatchSummary,
  PayrollImportFile,
  PayrollImportMatchStatus,
  PayrollImportPreviewRow,
  PayrollImportReminder,
  PayrollImportWorkspace,
} from "@/lib/payroll-balance-import-types";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MATCH_STATUSES = new Set<PayrollImportMatchStatus>(["linked", "inactive", "unmatched", "company_mismatch", "ambiguous"]);
const LOAD_ERROR = "Payroll balance import could not be loaded. Refresh and try again.";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(LOAD_ERROR);
  return value as Record<string, unknown>;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function nullableText(value: unknown) {
  const result = text(value);
  return result || null;
}

function positiveInteger(value: unknown, allowZero = false) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) throw new Error(LOAD_ERROR);
  return parsed;
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < -10_000 || parsed > 100_000) throw new Error(LOAD_ERROR);
  return parsed;
}

function boolean(value: unknown) {
  if (typeof value !== "boolean") throw new Error(LOAD_ERROR);
  return value;
}

function date(value: unknown, nullable: true): string | null;
function date(value: unknown, nullable?: false): string;
function date(value: unknown, nullable = false): string | null {
  const result = nullableText(value);
  if (result === null && nullable) return null;
  if (!result || !ISO_DATE_PATTERN.test(result)) throw new Error(LOAD_ERROR);
  return result;
}

function mapFile(value: unknown): PayrollImportFile {
  const row = record(value);
  const name = text(row.name);
  const sizeBytes = positiveInteger(row.sizeBytes);
  const employeeRows = positiveInteger(row.employeeRows);
  const companies = Array.isArray(row.companies)
    ? row.companies.filter((company): company is "mam" | "equipsy" => company === "mam" || company === "equipsy")
    : [];
  const asOfDates = Array.isArray(row.asOfDates) ? row.asOfDates.map((item) => date(item)) : [];
  if (!name || name.length > 180 || companies.length < 1 || companies.length > 2 || asOfDates.length < 1 || asOfDates.length > 12) {
    throw new Error(LOAD_ERROR);
  }
  return { name, sizeBytes, employeeRows, companies, asOfDates };
}

function mapPreviewRow(value: unknown): PayrollImportPreviewRow {
  const row = record(value);
  const company = text(row.company);
  const status = text(row.status) as PayrollImportMatchStatus;
  const employeeName = text(row.employeeName);
  const linkedName = nullableText(row.linkedName);
  if ((company !== "mam" && company !== "equipsy") || !MATCH_STATUSES.has(status) || !employeeName || employeeName.length > 200) {
    throw new Error(LOAD_ERROR);
  }
  return {
    rowId: positiveInteger(row.rowId),
    employeeName,
    company,
    annualHours: nullableNumber(row.annualHours),
    sickHours: nullableNumber(row.sickHours),
    asOf: date(row.asOf),
    status,
    linkedName,
    willApplyAnnual: boolean(row.willApplyAnnual),
    willApplySick: boolean(row.willApplySick),
  };
}

function mapBatch(value: unknown): PayrollImportBatch {
  const row = record(value);
  const batchId = text(row.batchId);
  const status = text(row.status);
  const files = Array.isArray(row.files) ? row.files.map(mapFile) : [];
  const rows = Array.isArray(row.rows) ? row.rows.map(mapPreviewRow) : [];
  const createdAt = text(row.createdAt);
  const committedAt = nullableText(row.committedAt);
  if (!UUID_PATTERN.test(batchId) || (status !== "staged" && status !== "committed") || !files.length || !rows.length || !createdAt) {
    throw new Error(LOAD_ERROR);
  }
  return {
    batchId,
    version: positiveInteger(row.version),
    status,
    files,
    rows,
    createdAt,
    committedAt,
  };
}

function mapReminder(value: unknown): PayrollImportReminder {
  const row = record(value);
  return {
    dueOn: date(row.dueOn),
    mamAsOf: date(row.mamAsOf, true),
    equipsyAsOf: date(row.equipsyAsOf, true),
    mamComplete: boolean(row.mamComplete),
    equipsyComplete: boolean(row.equipsyComplete),
    complete: boolean(row.complete),
  };
}

function mapBatchSummary(value: unknown): PayrollImportBatchSummary {
  const row = record(value);
  const batchId = text(row.batchId);
  const status = text(row.status);
  const files = Array.isArray(row.files) ? row.files.map(mapFile) : [];
  const createdAt = text(row.createdAt);
  const committedAt = nullableText(row.committedAt);
  if (!UUID_PATTERN.test(batchId) || (status !== "staged" && status !== "committed") || !files.length || !createdAt) throw new Error(LOAD_ERROR);
  return { batchId, status, files, rowCount: positiveInteger(row.rowCount), createdAt, committedAt };
}

function mapAccessPerson(value: unknown): PayrollImportAccessPerson {
  const row = record(value);
  const personId = text(row.person_id);
  const fullName = text(row.full_name);
  const positionTitle = text(row.position_title);
  if (!UUID_PATTERN.test(personId) || !fullName || !positionTitle) throw new Error(LOAD_ERROR);
  return { personId, fullName, positionTitle };
}

async function requireSession() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error("Your session has expired. Sign in again.");
  return { supabase, actorUserId: data.user.id };
}

async function requireImporter() {
  const { supabase, actorUserId } = await requireSession();
  const { data, error } = await supabase.rpc("can_import_payroll_balances");
  if (error || data !== true) throw new Error("You do not have permission to import payroll balances.");
  return { supabase, actorUserId };
}

async function requireAccessAdministrator() {
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("can_manage_payroll_balance_import_grants");
  if (error || data !== true) throw new Error("Only a Super Admin can manage payroll import access.");
  return supabase;
}

export async function getPayrollBalanceImportWorkspace(): Promise<PayrollImportWorkspace | null> {
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("get_payroll_balance_import_workspace");
  if (error || !data) return null;
  try {
    const row = record(data);
    if (row.canImport !== true) return null;
    return {
      canImport: true,
      canManageAccess: boolean(row.canManageAccess),
      reminder: mapReminder(row.reminder),
      recentBatches: Array.isArray(row.recentBatches) ? row.recentBatches.map(mapBatchSummary) : [],
    };
  } catch {
    throw new Error(LOAD_ERROR);
  }
}

export async function stagePayrollBalanceFiles(formData: FormData): Promise<
  { ok: true; batch: PayrollImportBatch } | { ok: false; message: string }
> {
  try {
    const { actorUserId } = await requireImporter();
    const files = formData.getAll("files");
    if (!files.length || files.some((file) => !(file instanceof File))) {
      return { ok: false, message: "Choose CSV or Excel leave-balance files." };
    }
    const parsed = await parsePayrollBalanceFiles(files as File[]);
    if (!SHA256_PATTERN.test(parsed.sourceDigest)) throw new Error("The upload digest is invalid.");
    let data: unknown;
    try {
      const result = await createAdminClient().rpc("stage_payroll_balance_import", {
        p_actor_user_id: actorUserId,
        p_source_digest: parsed.sourceDigest,
        p_files: parsed.files,
        p_rows: parsed.rows,
      });
      if (result.error || !result.data) {
        return { ok: false, message: "The files could not be staged. Check the format and try again." };
      }
      data = result.data;
    } catch {
      return { ok: false, message: "The files could not be staged. Check the format and try again." };
    }
    return { ok: true, batch: mapBatch(data) };
  } catch (reason) {
    return { ok: false, message: reason instanceof Error ? reason.message : "The files could not be read." };
  }
}

export async function commitPayrollBalanceImport(batchId: string, version: number): Promise<
  { ok: true; batch: PayrollImportBatch } | { ok: false; message: string }
> {
  try {
    const { supabase } = await requireImporter();
    if (!UUID_PATTERN.test(batchId) || !Number.isSafeInteger(version) || version < 1) {
      return { ok: false, message: "The payroll import is invalid. Upload the files again." };
    }
    const { data, error } = await supabase.rpc("commit_payroll_balance_import", {
      p_batch_id: batchId,
      p_expected_version: version,
    });
    if (error || !data) return { ok: false, message: "The payroll balances could not be applied. Re-open the upload and try again." };
    const batch = mapBatch(data);
    revalidatePath("/");
    return { ok: true, batch };
  } catch (reason) {
    return { ok: false, message: reason instanceof Error ? reason.message : "The payroll balances could not be applied." };
  }
}

export async function getPayrollBalanceImportAccessWorkspace(): Promise<PayrollImportAccessWorkspace> {
  const supabase = await requireAccessAdministrator();
  const [candidateResult, grantResult] = await Promise.all([
    supabase.rpc("list_payroll_balance_import_grant_candidates"),
    supabase.rpc("list_payroll_balance_import_grants"),
  ]);
  if (candidateResult.error || grantResult.error || !Array.isArray(candidateResult.data) || !Array.isArray(grantResult.data)) {
    throw new Error("Payroll import access could not be loaded.");
  }
  return {
    people: candidateResult.data.map(mapAccessPerson),
    grantedPersonIds: grantResult.data.map(mapAccessPerson).map((person) => person.personId),
  };
}

export async function replacePayrollBalanceImportGrants(personIds: string[]): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const supabase = await requireAccessAdministrator();
    if (!Array.isArray(personIds) || personIds.length > 25 || new Set(personIds).size !== personIds.length || personIds.some((id) => !UUID_PATTERN.test(id))) {
      return { ok: false, message: "Choose a valid unique payroll importer list." };
    }
    const { error } = await supabase.rpc("replace_payroll_balance_import_grants", { p_person_ids: personIds });
    if (error) return { ok: false, message: "Payroll import access could not be saved. Refresh and try again." };
    revalidatePath("/");
    return { ok: true };
  } catch (reason) {
    return { ok: false, message: reason instanceof Error ? reason.message : "Payroll import access could not be saved." };
  }
}
