"use server";
import { requirePortalRoleActor } from "@/lib/portal-role-access";
import { parsePortalRoleCapabilities } from "@/lib/portal-role-capabilities";

import "server-only";

import { revalidatePath } from "next/cache";

import {
  parsePreparedPayrollBalanceFiles,
  preparePayrollBalanceFiles,
} from "@/lib/payroll-balance-import";
import {
  archivePayrollBalanceFiles,
  linkPayrollBalanceSourceArchives,
  markPayrollBalanceSourceArchivesFailed,
} from "@/lib/payroll-balance-source-archive";
import type {
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
    comparisonOnly: row.comparisonOnly === true,
    differenceCount: positiveInteger(row.differenceCount ?? 0, true),
    comparisonRows: Array.isArray(row.comparisonRows) ? row.comparisonRows.map((item) => {
      const value = record(item);
      return { rowId: positiveInteger(value.rowId), employeeName: text(value.employeeName), company: text(value.company),
        kind: text(value.kind), uploadedHours: nullableNumber(value.uploadedHours) ?? 0, systemHours: nullableNumber(value.systemHours),
        fileAsOf: date(value.fileAsOf), systemAsOf: date(value.systemAsOf, true), different: boolean(value.different) };
    }) : [],
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

async function requireSession() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error("Your session has expired. Sign in again.");
  return { supabase, actorUserId: data.user.id };
}

async function requireImporter(previewPersonId?: string) {
  const { supabase, actorUserId, capabilities: actor } = await requirePortalRoleActor();
  let capabilities = actor;
  if (previewPersonId !== undefined) {
    if (!UUID_PATTERN.test(previewPersonId) || !actor.is_super_admin || !actor.can_change_employee_view) throw new Error("Payroll preview access could not be confirmed.");
    const { data, error } = await supabase.rpc("get_portal_role_capabilities", { p_person_id: previewPersonId });
    if (error) throw new Error("Payroll preview access could not be confirmed.");
    capabilities = parsePortalRoleCapabilities(data, previewPersonId);
  }
  if (!actor.can_import_payroll_balances || !capabilities.can_import_payroll_balances) throw new Error("You do not have permission to import payroll balances.");
  return { supabase, actorUserId, capabilities };
}

export type PayrollImportWorkspaceResult =
  | { status: "ready"; workspace: PayrollImportWorkspace }
  | { status: "forbidden" }
  | { status: "error"; message: string };

export async function getPayrollBalanceImportWorkspace(previewPersonId?: string): Promise<PayrollImportWorkspaceResult> {
  try {
    const { supabase } = previewPersonId ? await requireImporter(previewPersonId) : await requireSession();
    const { data, error } = previewPersonId
      ? await supabase.rpc("get_payroll_balance_import_workspace_for_preview", { p_person_id: previewPersonId })
      : await supabase.rpc("get_payroll_balance_import_workspace");
    if (error || !data) return { status: "error", message: LOAD_ERROR };
    const row = record(data);
    // Only an explicit capability denial means the feature is unavailable.
    // RPC, session and payload failures remain recoverable load errors.
    if (row.canImport === false) return { status: "forbidden" };
    if (row.canImport !== true || !Array.isArray(row.recentBatches)) throw new Error(LOAD_ERROR);
    return {
      status: "ready",
      workspace: {
        canImport: true,
        canManageAccess: !previewPersonId && boolean(row.canManageAccess),
        reminder: mapReminder(row.reminder),
        recentBatches: row.recentBatches.map(mapBatchSummary),
      },
    };
  } catch {
    return { status: "error", message: LOAD_ERROR };
  }
}

export async function stagePayrollBalanceFiles(formData: FormData, previewPersonId?: string): Promise<
  { ok: true; batch: PayrollImportBatch } | { ok: false; message: string }
> {
  try {
    const { actorUserId, capabilities } = await requireImporter(previewPersonId);
    const files = formData.getAll("files");
    if (!files.length || files.some((file) => !(file instanceof File))) {
      return { ok: false, message: "Choose CSV or Excel leave-balance files." };
    }
    const preparedFiles = await preparePayrollBalanceFiles(files as File[]);
    const archiveIds = await archivePayrollBalanceFiles(actorUserId, preparedFiles);
    let parsed: Awaited<ReturnType<typeof parsePreparedPayrollBalanceFiles>>;
    try {
      parsed = await parsePreparedPayrollBalanceFiles(preparedFiles);
    } catch (reason) {
      try {
        await markPayrollBalanceSourceArchivesFailed(actorUserId, archiveIds);
      } catch {
        // The upload plan itself still enforces the minimum retention window.
      }
      throw reason;
    }
    if (!SHA256_PATTERN.test(parsed.sourceDigest)) throw new Error("The upload digest is invalid.");
    let data: unknown;
    try {
      const result = await createAdminClient().rpc(previewPersonId ? "stage_payroll_balance_import_for_preview" : "stage_payroll_balance_import", {
        p_actor_user_id: actorUserId,
        ...(previewPersonId ? { p_person_id: previewPersonId } : {}),
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
    const batch = mapBatch(data);
    if (capabilities.payroll_comparison_only && !batch.comparisonOnly) return { ok: false, message: "The comparison result could not be confirmed. Refresh before trying again." };
    await linkPayrollBalanceSourceArchives(actorUserId, archiveIds, batch.batchId);
    return { ok: true, batch };
  } catch (reason) {
    return { ok: false, message: reason instanceof Error ? reason.message : "The files could not be read." };
  }
}

export async function commitPayrollBalanceImport(batchId: string, version: number, previewPersonId?: string): Promise<
  { ok: true; batch: PayrollImportBatch } | { ok: false; message: string }
> {
  try {
    const { supabase, capabilities } = await requireImporter(previewPersonId);
    if (capabilities.payroll_comparison_only || !capabilities.can_manage_leave_balances) return { ok: false, message: "Comparison-only access cannot apply payroll balances." };
    if (!UUID_PATTERN.test(batchId) || !Number.isSafeInteger(version) || version < 1) {
      return { ok: false, message: "The payroll import is invalid. Upload the files again." };
    }
    if (previewPersonId) await requirePreviewBatchAccess(supabase, batchId, previewPersonId, true);
    const { data, error } = await supabase.rpc("commit_payroll_balance_import", {
      p_batch_id: batchId,
      p_expected_version: version,
    });
    if (error || !data) return { ok: false, message: "The payroll balances could not be applied. Re-open the upload and try again." };
    const batch = mapBatch(data);
    revalidatePath("/");
    return { ok: true, batch };
  } catch (reason) {
    return { ok: false, message: previewPersonId !== undefined ? LOAD_ERROR : reason instanceof Error ? reason.message : "The payroll balances could not be applied." };
  }
}

export async function replacePayrollBalanceImportGrants(personIds: string[]): Promise<{ ok: false; message: string }> {
  try {
    const { capabilities } = await requirePortalRoleActor();
    if (!capabilities.is_super_admin) return { ok: false, message: "Only a Super Admin can manage payroll import access." };
    if (!Array.isArray(personIds) || personIds.length > 25 || new Set(personIds).size !== personIds.length || personIds.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))) {
      return { ok: false, message: "Choose a valid unique payroll importer list." };
    }
    return { ok: false, message: "Payroll import access is controlled by portal roles." };
  } catch {
    return { ok: false, message: "Payroll import access could not be confirmed. Refresh and try again." };
  }
}

async function requirePreviewBatchAccess(supabase: Awaited<ReturnType<typeof createClient>>, batchId: string, previewPersonId: string, canCommit = false) {
  try {
    const { data, error } = await supabase.rpc("get_payroll_balance_import_workspace_for_preview", { p_person_id: previewPersonId });
    if (error || !data) throw new Error(LOAD_ERROR);
    const workspace = record(data);
    if (workspace.canImport !== true || !Array.isArray(workspace.recentBatches)) throw new Error(LOAD_ERROR);
    const comparisonOnly = boolean(workspace.comparisonOnly);
    const canManageBalances = boolean(workspace.canManageBalances);
    boolean(workspace.canManageAccess);
    mapReminder(workspace.reminder);
    const batches = workspace.recentBatches.map(mapBatchSummary);
    if (!batches.some(batch => batch.batchId === batchId) || (canCommit && (comparisonOnly || !canManageBalances))) throw new Error(LOAD_ERROR);
  } catch {
    throw new Error(LOAD_ERROR);
  }
}

export async function getPayrollBalanceImportBatch(batchId: string, previewPersonId?: string): Promise<PayrollImportBatch> {
  try {
    const { supabase, capabilities } = await requireImporter(previewPersonId);
    if (!UUID_PATTERN.test(batchId)) throw new Error(LOAD_ERROR);
    if (previewPersonId) await requirePreviewBatchAccess(supabase, batchId, previewPersonId);
    const { data, error } = await supabase.rpc("get_payroll_balance_import_batch", { p_batch_id: batchId });
    if (error || !data) throw new Error(LOAD_ERROR);
    const batch = mapBatch(data);
    if (previewPersonId && (batch.batchId !== batchId || (capabilities.payroll_comparison_only && !batch.comparisonOnly))) throw new Error(LOAD_ERROR);
    return batch;
  } catch (reason) {
    if (previewPersonId === undefined) throw reason;
    throw new Error(LOAD_ERROR);
  }
}
