"use server";

import { requirePerformanceReviewActor, PerformanceReviewAccessError } from "@/lib/performance-review-auth";
import { buildXlsxWorkbook } from "@/lib/xlsx-export";
import type { AnnualReviewExcelResult, AnnualReviewReport, AnnualReviewReportResult, AnnualReviewReportRow } from "@/lib/annual-review-report-types";

function yearValue(value: string) {
  return /^\d{4}$/.test(value) && Number(value) >= 2000 && Number(value) <= 2100;
}

function errorMessage(error: unknown) {
  if (error instanceof PerformanceReviewAccessError && error.code === "unauthenticated") return "Sign in to view this report.";
  if (error instanceof PerformanceReviewAccessError && error.code === "forbidden") return "You do not have permission to view this report.";
  return "Annual review reporting is unavailable. Please try again.";
}

async function readReport(year: string, includeInactive: boolean): Promise<AnnualReviewReport> {
  if (!yearValue(year) || typeof includeInactive !== "boolean") throw new Error("Invalid report filters.");
  const { supabase, capabilities } = await requirePerformanceReviewActor();
  if (!["admin", "system_admin"].includes(capabilities.app_role)) {
    throw new PerformanceReviewAccessError("forbidden");
  }

  const { data, error, status } = await supabase.rpc("get_annual_review_report", {
    p_cycle: year,
    p_include_inactive: includeInactive,
  });
  if (error || status >= 400 || !data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Annual review report could not be loaded.");
  }

  const report = data as AnnualReviewReport;
  if (report.reviewYear !== year || !Array.isArray(report.rows)
    || !report.summary || !Array.isArray(report.availableYears)
    || report.rows.some(row =>
      !row || typeof row.employeeId !== "string" || typeof row.employeeName !== "string"
      || row.reviewYear !== year || typeof row.status !== "string"
      || typeof row.reviewTriggered !== "boolean"
      || typeof row.employeeCompleted !== "boolean"
      || typeof row.managerCompleted !== "boolean")) {
    throw new Error("Annual review reporting returned invalid data.");
  }
  return report;
}

export async function loadAnnualReviewReport(year: string, includeInactive: boolean): Promise<AnnualReviewReportResult> {
  if (process.env.MAM_PERFORMANCE_REVIEW_ENABLED !== "true") return { ok: false, message: "Performance reviews are not available." };
  if (!yearValue(year) || typeof includeInactive !== "boolean") return { ok: false, message: "Select a valid review year." };
  try {
    return { ok: true, report: await readReport(year, includeInactive) };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

function excelValue(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function excelRow(row: AnnualReviewReportRow) {
  return [
    row.employeeName, row.company, row.department, row.jobTitle,
    row.managerName ?? "", row.reviewYear,
    excelValue(row.eligible === null ? "Unknown" : row.eligible),
    excelValue(row.reviewTriggered), row.triggeredBy ?? "", row.triggeredDate ?? "",
    excelValue(row.employeeCompleted), row.employeeCompletionDate ?? "",
    excelValue(row.managerCompleted), row.managerCompletionDate ?? "",
    row.dueDate ?? "", row.status, row.employeeActive ? "Active" : "Inactive",
  ];
}

export async function exportAnnualReviewExcel(
  year: string, includeInactive: boolean, selectedEmployeeIds: string[],
): Promise<AnnualReviewExcelResult> {
  if (process.env.MAM_PERFORMANCE_REVIEW_ENABLED !== "true") return { ok: false, message: "Performance reviews are not available." };
  if (!yearValue(year) || typeof includeInactive !== "boolean"
    || !Array.isArray(selectedEmployeeIds) || selectedEmployeeIds.length > 500
    || selectedEmployeeIds.some(id => typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))) {
    return { ok: false, message: "Invalid report export request." };
  }
  try {
    // Fetch a fresh authorised projection; never accept employee names or statuses from the browser.
    const report = await readReport(year, includeInactive);
    const selected = new Set(selectedEmployeeIds);
    const rows = selectedEmployeeIds.length
      ? report.rows.filter(row => selected.has(row.employeeId))
      : [];
    const headers = [
      "Employee", "Company", "Department", "Job title", "Manager", "Review year",
      "Eligible", "Review triggered", "Triggered by", "Date triggered",
      "Employee completed", "Employee completion date", "Manager completed",
      "Manager completion date", "Due date", "Status", "Employee record",
    ];
    const workbook = buildXlsxWorkbook([{
      name: "Annual reviews",
      rows: [headers, ...rows.map(excelRow)],
    }]);
    return {
      ok: true,
      fileName: "MAM-Annual-Reviews-" + year + ".xlsx",
      base64: Buffer.from(workbook).toString("base64"),
    };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}
