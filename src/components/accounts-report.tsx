"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, RefreshCcw, Search } from "lucide-react";
import { fetchAccountsReport, type AccountsReportRow } from "@/app/people/accounts-report-actions";
import styles from "./accounts-report.module.css";

const weekdayNames: Record<number, string> = {1:"Mon",2:"Tue",3:"Wed",4:"Thu",5:"Fri",6:"Sat",7:"Sun"};
const locationNames: Record<string, string> = { hq:"HQ", onsite_trade:"Onsite Trade", remote_worker:"Remote Worker", hybrid:"Hybrid", overseas:"Overseas" };
const employmentNames: Record<string, string> = { abn:"ABN", casual:"Casual", full_time:"Full Time", part_time:"Part Time", overseas:"Overseas" };
const sourceNames: Record<string, string> = {aroflo:"AroFlo",deputy:"Deputy",hubstaff:"Hubstaff",deputy_hubstaff:"Deputy & Hubstaff",aroflo_hubstaff:"AroFlo & Hubstaff",aroflo_deputy:"AroFlo & Deputy"};

function daysText(row: AccountsReportRow) {
  return row.work_days?.map((day) => weekdayNames[day] ?? "?").join(", ") || "—";
}
function timesText(row: AccountsReportRow) {
  const times = row.daily_times || [];
  if (!times.length) return "—";
  const distinct = [...new Set(times.map((time) => `${time.start_time}–${time.end_time}`))];
  // Work Days has its own column. Avoid repeating weekday labels alongside regular hours.
  return distinct.length === 1 ? distinct[0] : `Varies: ${distinct.join(" / ")}`;
}
const columns = ["Employee", "Team Lead", "Team", "Company", "Location", "Work Days", "Start – Finish", "Expected Hours", "Employment Type", "Timesheet Entries"];
const csvCell = (value: string) => {
  const safe = /^[\s]*[=+\-@]/.test(value) ? "'" + value : value;
  return '"' + safe.replaceAll('"', '""') + '"';
};
function rowValues(row: AccountsReportRow) {
  return [
    row.employee_name, row.team_lead || "—", row.team, row.company,
    locationNames[row.location ?? ""] ?? "—", daysText(row), timesText(row),
    row.expected_hours === null ? "—" : String(row.expected_hours),
    employmentNames[row.employment_type ?? ""] ?? "—",
    sourceNames[row.timesheet_entries ?? ""] ?? "—",
  ];
}

export function AccountsReport({ onOpenEmployeeProfile }: { onOpenEmployeeProfile?: (personId: string) => void }) {
  const [rows, setRows] = useState<AccountsReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [company, setCompany] = useState("All");
  const [team, setTeam] = useState("All");
  const [source, setSource] = useState("All");
  async function load() {
    setLoading(true);
    const result = await fetchAccountsReport();
    if ("error" in result) { setError(result.error); setRows([]); }
    else { setError(""); setRows(result.rows); }
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);
  const teams = useMemo(() => [...new Set(rows.map((row) => row.team).filter(Boolean))].sort(), [rows]);
  const visible = useMemo(() => rows.filter((row) =>
    (company === "All" || row.company === company)
    && (team === "All" || row.team === team)
    && (source === "All" || row.timesheet_entries === source)
    && [row.employee_name, row.team_lead, row.team, row.company, row.timesheet_entries ?? ""]
      .some((value) => value.toLowerCase().includes(search.trim().toLowerCase()))
  ), [rows, company, team, source, search]);
  function exportCsv() {
    const csv = "\uFEFF" + [columns, ...visible.map(rowValues)].map((r) => r.map(csvCell).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "People-Hub-Accounts-Report.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }
  return <section className={styles.root} aria-label="Accounts Report">
    <header className={styles.heading}>
      <div><h2>Accounts Report</h2><p>Live active employee details from People Hub · No timesheets or payroll amounts are imported.</p></div>
      <div className={styles.actions}>
        <button type="button" onClick={() => void load()} disabled={loading}><RefreshCcw size={15} /> Refresh</button>
        <button type="button" onClick={exportCsv} disabled={loading || !visible.length}><Download size={15} /> Export CSV</button>
      </div>
    </header>
    <div className={styles.filters}>
      <label><span>Find employee</span><div className={styles.search}><Search size={15}/><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, lead or team" /></div></label>
      <label><span>Company</span><select value={company} onChange={(e) => setCompany(e.target.value)}><option>All</option><option>MAM</option><option>Equipsy</option></select></label>
      <label><span>Team</span><select value={team} onChange={(e) => setTeam(e.target.value)}><option>All</option>{teams.map((name) => <option key={name}>{name}</option>)}</select></label>
      <label><span>Timesheet entries</span><select value={source} onChange={(e) => setSource(e.target.value)}><option value="All">All</option>{Object.entries(sourceNames).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    </div>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    <p className={styles.count}>{loading ? "Loading employee records…" : `${visible.length} of ${rows.length} active employees`}</p>
    <div className={styles.tableWrap}>
      <table><thead><tr>{columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead>
        <tbody>{visible.map((row) => <tr key={row.person_id}>{rowValues(row).map((value,i) => <td key={columns[i]}>{i === 0 && onOpenEmployeeProfile
          ? <button type="button" className={styles.employeeLink} onClick={() => onOpenEmployeeProfile(row.person_id)} title={`Open ${row.employee_name}'s profile`}>{value}</button>
          : value}</td>)}</tr>)}</tbody>
      </table>
    </div>
    {!loading && !visible.length && !error ? <p>No employees match the current filters.</p> : null}
    <p className={styles.note}>Expected Hours is a separately recorded weekly figure and is not calculated from start/finish times. A dash means the value has not been supplied.</p>
  </section>;
}
