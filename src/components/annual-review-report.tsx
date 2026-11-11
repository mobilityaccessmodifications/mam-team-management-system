"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, RefreshCw, Search } from "lucide-react";
import { exportAnnualReviewExcel, loadAnnualReviewReport } from "@/app/performance-reviews/report-actions";
import type { AnnualReviewReport as Report, AnnualReviewReportRow, AnnualReviewStatus } from "@/lib/annual-review-report-types";
import styles from "./annual-review-report.module.css";

const STATUS_OPTIONS: AnnualReviewStatus[] = [
  "Not Eligible", "Not Triggered", "Awaiting Both", "Awaiting Employee",
  "Awaiting Manager", "Awaiting Finalisation", "Finalised",
];

function currentYear() {
  return new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Melbourne", year: "numeric" }).format(new Date());
}

function dateText(value: string | null) {
  return value ? value.split("T", 1)[0] : "—";
}

function csvCell(value: string | number | boolean | null | undefined) {
  const text = value === null || value === undefined ? "" : typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
  // Spreadsheet formula injection must not be possible via staff names or free-text labels.
  const safe = /^[=+\-@\t\r\n]/.test(text) ? "'" + text : text;
  return '"' + safe.replace(/"/g, '""') + '"';
}

function downloadFile(contents: BlobPart, mimeType: string, filename: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function reportCells(row: AnnualReviewReportRow): (string | number | boolean | null)[] {
  return [
    row.employeeName, row.company, row.department, row.jobTitle, row.managerName,
    row.reviewYear, row.eligible === null ? "Unknown" : row.eligible,
    row.reviewTriggered, row.triggeredBy, row.triggeredDate,
    row.employeeCompleted, row.employeeCompletionDate, row.managerCompleted,
    row.managerCompletionDate, row.dueDate, row.status,
    row.employeeActive ? "Active" : "Inactive",
  ];
}

const HEADERS = [
  "Employee", "Company", "Department", "Job title", "Manager", "Review year",
  "Eligible", "Review triggered", "Triggered by", "Date triggered",
  "Employee completed", "Employee completion date", "Manager completed",
  "Manager completion date", "Due date", "Status", "Employee record",
];

export default function AnnualReviewReport() {
  const [year, setYear] = useState(currentYear);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [query, setQuery] = useState("");
  const [company, setCompany] = useState("");
  const [department, setDepartment] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    loadAnnualReviewReport(year, includeInactive).then(result => {
      if (!active) return;
      if (result.ok) {
        setReport(result.report);
        setMessage("");
      } else {
        setReport(null);
        setMessage(result.message);
      }
    }).catch(() => {
      if (active) { setReport(null); setMessage("The report could not be loaded."); }
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [year, includeInactive, refreshKey]);

  const rows = report?.reviewYear === year && report.includesInactive === includeInactive ? report.rows : [];
  const companies = useMemo(() => [...new Set(rows.map(row => row.company).filter(Boolean))].sort(), [rows]);
  const departments = useMemo(() => [...new Set(rows.filter(row => !company || row.company === company).map(row => row.department).filter(Boolean))].sort(), [rows, company]);
  const filteredRows = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return rows.filter(row => (!search || [row.employeeName, row.department, row.managerName, row.triggeredBy, row.jobTitle, row.company]
      .join(" ").toLocaleLowerCase().includes(search))
      && (!company || row.company === company)
      && (!department || row.department === department)
      && (!statusFilter || row.status === statusFilter));
  }, [rows, query, company, department, statusFilter]);

  function refresh() {
    setLoading(true);
    setMessage("");
    setRefreshKey(key => key + 1);
  }

  function downloadCsv() {
    const cells = [HEADERS, ...filteredRows.map(reportCells)];
    const csv = "\uFEFF" + cells.map(row => row.map(csvCell).join(",")).join("\r\n");
    downloadFile(csv, "text/csv;charset=utf-8", "MAM-Annual-Reviews-" + year + ".csv");
  }

  async function downloadExcel() {
    if (exporting || loading || !report) return;
    setExporting(true);
    setMessage("");
    try {
      const result = await exportAnnualReviewExcel(year, includeInactive, filteredRows.map(row => row.employeeId));
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      const binary = atob(result.base64);
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      downloadFile(bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", result.fileName);
    } catch {
      setMessage("Excel export failed. Please try again.");
    } finally {
      setExporting(false);
    }
  }

  const availableYears = [...new Set([currentYear(), year, ...(report?.availableYears ?? [])])]
    .filter(value => /^\d{4}$/.test(value)).sort((a, b) => b.localeCompare(a));

  return <section className={styles.report} aria-label="Annual review report">
    <div className={styles.heading}>
      <div><h2>Annual Review Report</h2><p>All employees, review activity and submission dates from People Hub.</p></div>
      <div className={styles.actions}>
        <button type="button" onClick={refresh} disabled={loading} aria-label="Refresh annual review report"><RefreshCw size={16} aria-hidden="true" /> Refresh</button>
        <button type="button" disabled={loading || !report} onClick={downloadCsv}><Download size={16} aria-hidden="true" /> Export CSV</button>
        <button type="button" disabled={loading || !report || exporting} onClick={() => void downloadExcel()}><Download size={16} aria-hidden="true" /> {exporting ? "Exporting…" : "Export Excel"}</button>
      </div>
    </div>
    {message ? <p className={styles.error} role="alert">{message}</p> : null}
    {report && !loading ? <div className={styles.metrics} aria-label="Annual review report summary">
      {[
        ["Employees", report.summary.totalEmployees],
        ["Triggered", report.summary.triggered],
        ["Not triggered", report.summary.notTriggered],
        ["Employee complete", report.summary.employeeCompleted],
        ["Manager complete", report.summary.managerCompleted],
        ["Finalised", report.summary.finalised],
      ].map(([label, count]) => <div className={styles.metric} key={String(label)}>
        <strong>{count}</strong><span>{label}</span>
      </div>)}
    </div> : null}
    <div className={styles.filters}>
      <label>Review year
        <select value={year} onChange={event => { setYear(event.target.value); setLoading(true); }}>
          {availableYears.map(value => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <label>Search
        <span className={styles.search}><Search size={16} aria-hidden="true" /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Name, manager or team" /></span>
      </label>
      <label>Company
        <select value={company} onChange={event => { setCompany(event.target.value); setDepartment(""); }}>
          <option value="">All companies</option>{companies.map(value => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <label>Department
        <select value={department} onChange={event => setDepartment(event.target.value)}>
          <option value="">All departments</option>{departments.map(value => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <label>Status
        <select value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
          <option value="">All statuses</option>{STATUS_OPTIONS.map(value => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <label className={styles.checkbox}><input type="checkbox" checked={includeInactive} onChange={event => { setIncludeInactive(event.target.checked); setLoading(true); }} /> Include inactive employees</label>
    </div>
    {loading ? <p role="status">Loading annual review report…</p> : report ? <>
      <p className={styles.caption} role="status">{filteredRows.length} of {rows.length} employees · Review year {year} · As at {dateText(report.asOfDate)}</p>
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead><tr>
            <th scope="col">Employee</th><th scope="col">Company</th><th scope="col">Department</th>
            <th scope="col">Manager</th><th scope="col">Triggered?</th><th scope="col">Triggered by</th>
            <th scope="col">Date triggered</th><th scope="col">Employee completed?</th>
            <th scope="col">Employee date</th><th scope="col">Manager completed?</th>
            <th scope="col">Manager date</th><th scope="col">Status</th>
          </tr></thead>
          <tbody>{filteredRows.map(row => <tr key={row.employeeId}>
            <th scope="row">{row.employeeName}{!row.employeeActive ? <small>Inactive</small> : null}</th>
            <td>{row.company}</td><td>{row.department || "—"}</td><td>{row.managerName || "—"}</td>
            <td>{row.reviewTriggered ? "Yes" : "No"}</td><td>{row.triggeredBy || "—"}</td>
            <td>{dateText(row.triggeredDate)}</td><td>{row.employeeCompleted ? "Yes" : "No"}</td>
            <td>{dateText(row.employeeCompletionDate)}</td><td>{row.managerCompleted ? "Yes" : "No"}</td>
            <td>{dateText(row.managerCompletionDate)}</td>
            <td><span className={styles.status}>{row.status}</span></td>
          </tr>)}</tbody>
        </table>
      </div>
      {filteredRows.length === 0 ? <p className={styles.caption}>No employees match the selected filters.</p> : null}
      <p className={styles.caption}>Not Eligible means the employee has under 12 months of recorded service and no triggered review. Missing start dates remain Not Triggered until eligibility can be confirmed. Exports include the currently filtered employees.</p>
    </> : null}
  </section>;
}
