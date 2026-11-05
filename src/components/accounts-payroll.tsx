"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchAccountsPayrollWeek, type AccountsPayrollWeek, type PayrollLeaveRequest } from "@/app/people/accounts-report-actions";
import type { AccountsReportRow } from "@/app/people/accounts-report-actions";
import styles from "./accounts-payroll.module.css";

const dayMs = 86400000;
function iso(date: Date) { return date.toISOString().slice(0, 10); }
function monday(date: Date) {
  const weekday = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - ((weekday + 6) % 7));
  return iso(date);
}
function fromDate(value: string) { return new Date(value + "T12:00:00Z"); }
function addDays(value: string, days: number) {
  const d = fromDate(value);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
}
function hoursBetween(start: string, end: string) {
  const toMinutes = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));
  return Math.max(0, (toMinutes(end) - toMinutes(start)) / 60);
}
function weekday(value: string) {
  const d = fromDate(value).getUTCDay();
  return d === 0 ? 7 : d;
}
function rounded(value: number) { return Math.round(value * 100) / 100; }
function duration(value: number) { return `${rounded(value).toLocaleString("en-AU", {maximumFractionDigits:2})}h`; }
function entrySchedule(row: AccountsReportRow) {
  const records = new Map<number, number>();
  for (const t of row.daily_times ?? []) {
    records.set(t.weekday, hoursBetween(t.start_time, t.end_time));
  }
  const working = row.work_days ?? [];
  const gross = working.reduce((sum, day) => sum + (records.get(day) ?? 0), 0);
  const weekly = row.expected_hours === null ? null : Number(row.expected_hours);
  const factor = weekly !== null && Number.isFinite(weekly) && gross > 0 ? weekly / gross : 1;
  return { records, factor, weekly: weekly !== null && Number.isFinite(weekly) ? weekly : (gross > 0 ? gross : null) };
}
type Cell = { approved: number; submitted: number; rejected: number; cancelled: number; estimated: boolean; notes: string[] };
function emptyCell(): Cell { return { approved: 0, submitted: 0, rejected: 0, cancelled: 0, estimated: false, notes: [] }; }
function statusOf(value: string): keyof Pick<Cell, "approved" | "submitted" | "rejected" | "cancelled"> {
  return value === "approved" || value === "rejected" || value === "cancelled" ? value : "submitted";
}
function leaveHours(leave: PayrollLeaveRequest, date: string, workHours: number, weekStart: string) {
  if (workHours <= 0) return null;
  // Explicit single-day hours are authoritative; multi-day hours cannot safely be distributed.
  if (leave.start_date === leave.end_date && leave.hours !== null) {
    const exact = Number(leave.hours);
    if (Number.isFinite(exact) && exact >= 0) return { value: exact, estimated: false };
  }
  if (leave.start_date === leave.end_date && leave.start_time && leave.end_time) {
    return { value: hoursBetween(leave.start_time, leave.end_time), estimated: true };
  }
  // Partial-day boundaries on a multi-day request cannot be inferred reliably.
  if ((date === leave.start_date && leave.start_time) || (date === leave.end_date && leave.end_time)) return null;
  void weekStart;
  return { value: workHours, estimated: true };
}
export type PayrollComputedRow = {
  employee: AccountsReportRow;
  scheduled: number | null;
  sick: Cell;
  annual: Cell;
  unpaid: Cell;
  holiday: number | null;
  warning: string[];
};
function compute(row: AccountsReportRow, data: AccountsPayrollWeek, start: string): PayrollComputedRow {
  const schedule = entrySchedule(row);
  const result: PayrollComputedRow = {
    employee: row, scheduled: schedule.weekly, sick: emptyCell(), annual: emptyCell(), unpaid: emptyCell(),
    holiday: row.location === "overseas" || (row.location === "remote_worker" && row.company !== "MAM") ? null : 0,
    warning: [],
  };
  const holidayDates = new Map(data.holidays.map((h) => [h.date, h.name]));
  const dayLeaves = data.leave.filter((l) => l.person_id === row.person_id);
  const timeByDay = new Map<number, number>();
  for (const [day, gross] of schedule.records) timeByDay.set(day, gross * schedule.factor);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const scheduledSet = new Set(row.work_days ?? []);
  for (const date of days) {
    const day = weekday(date);
    if (!scheduledSet.has(day)) continue;
    const hours = timeByDay.get(day) ?? 0;
    const holidayName = holidayDates.get(date);
    if (holidayName && result.holiday !== null) {
      result.holiday += hours;
    }
    const matching = dayLeaves.filter((leave) => date >= leave.start_date && date <= leave.end_date);
    for (const leave of matching) {
      const bucket = leave.leave_type === "annual" ? result.annual : leave.leave_type === "unpaid" ? result.unpaid : result.sick;
      const amount = leaveHours(leave, date, hours, start);
      if (!amount) {
        result.warning.push(`${leave.label} on ${date}: cannot calculate hours from the saved schedule`);
        continue;
      }
      const state = statusOf(leave.status);
      bucket[state] += amount.value;
      bucket.estimated ||= amount.estimated;
      if (!bucket.notes.includes(leave.label)) bucket.notes.push(leave.label);
      if (holidayName && leave.status !== "cancelled") result.warning.push(`Leave and public holiday overlap on ${date}`);
    }
  }
  for (const cat of [result.sick, result.annual, result.unpaid]) {
    if (cat.approved + cat.submitted > 0 && !schedule.records.size) result.warning.push("No daily work hours saved");
  }
  result.warning = [...new Set(result.warning)];
  if (result.holiday !== null) result.holiday = rounded(result.holiday);
  return result;
}
function leaveText(cell: Cell) {
  return [
    cell.approved ? `${duration(cell.approved)} Approved${cell.estimated ? " (est.)" : ""}` : "",
    cell.submitted ? `${duration(cell.submitted)} Pending${cell.estimated ? " (est.)" : ""}` : "",
    cell.rejected ? `${duration(cell.rejected)} Rejected` : "",
    cell.cancelled ? `${duration(cell.cancelled)} Cancelled` : "",
  ].filter(Boolean).join("; ") || "—";
}
function CellView({ cell }: { cell: Cell }) {
  if (!cell.approved && !cell.submitted && !cell.rejected && !cell.cancelled) return <>—</>;
  return <div className={styles.statuses}>
    {cell.approved > 0 ? <span className={styles.approved} title={cell.notes.join(", ")}>{duration(cell.approved)} Approved{cell.estimated ? " *" : ""}</span> : null}
    {cell.submitted > 0 ? <span className={styles.pending} title={cell.notes.join(", ")}>{duration(cell.submitted)} Pending{cell.estimated ? " *" : ""}</span> : null}
    {cell.rejected > 0 ? <span className={styles.rejected}>{duration(cell.rejected)} Rejected</span> : null}
    {cell.cancelled > 0 ? <span className={styles.cancelled}>{duration(cell.cancelled)} Cancelled</span> : null}
  </div>;
}
export function AccountsPayroll({ employees, onOpenEmployeeProfile }: {
  employees: AccountsReportRow[];
  onOpenEmployeeProfile?: (id: string) => void;
}) {
  const [weekStart, setWeekStart] = useState(() => monday(new Date()));
  const [data, setData] = useState<AccountsPayrollWeek | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [company, setCompany] = useState("All");
  const [team, setTeam] = useState("All");
  const [status, setStatus] = useState("All");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    void fetchAccountsPayrollWeek(weekStart).then((response) => {
      if (cancelled) return;
      if ("error" in response) { setError(response.error); setData(null); }
      else setData(response.data);
    }).catch(() => { if (!cancelled) setError("Unable to load payroll week."); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [weekStart, reload]);
  const teams = useMemo(() => [...new Set(employees.map((r) => r.team))].sort(), [employees]);
  const rows = useMemo(() => data ? employees.map((r) => compute(r, data, weekStart)).filter((r) =>
    (company === "All" || r.employee.company === company) &&
    (team === "All" || r.employee.team === team) &&
    (search === "" || [r.employee.employee_name, r.employee.team, r.employee.team_lead].some((v) => v.toLowerCase().includes(search.trim().toLowerCase()))) &&
    (status === "All" || (status === "Needs review" && (r.warning.length > 0 || [r.sick,r.annual,r.unpaid].some((c) => c.submitted || c.rejected))) ||
     (status === "Has leave" && [r.sick,r.annual,r.unpaid].some((c) => c.approved || c.submitted || c.rejected)))
  ) : [], [data, employees, weekStart, company, team, search, status]);
  function exportCsv() {
    const heading = ["Employee", "Company", "Team", "Week starting", "Scheduled hours (reference)", "Sick leave", "Annual leave", "Unpaid leave", "Public holidays (VIC scheduled, not confirmed paid)", "Review notes"];
    const records = rows.map((r) => [r.employee.employee_name, r.employee.company, r.employee.team, weekStart, r.scheduled === null ? "Unknown" : String(rounded(r.scheduled)), leaveText(r.sick), leaveText(r.annual), leaveText(r.unpaid), r.holiday === null ? "Not assessed" : String(r.holiday), r.warning.join("; ")]);
    const csvCell = (x: string) => '"' + (/^\s*[=+@-]/.test(x) ? "'" + x : x).replaceAll('"','""') + '"';
    const blob = new Blob(["\uFEFF" + [heading, ...records].map((r) => r.map(csvCell).join(",")).join("\r\n")], {type:"text/csv;charset=utf-8"});
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = `People-Hub-Payroll-${weekStart}.csv`; link.click();
    URL.revokeObjectURL(url);
  }
  return <section className={styles.root} aria-label="Payroll work-week report">
    <div className={styles.toolbar}>
      <label>Work week starting (Monday)<input type="date" value={weekStart} onChange={(e) => { if (e.target.value) setWeekStart(monday(fromDate(e.target.value))); }} /></label>
      <button type="button" onClick={() => setWeekStart(addDays(weekStart,-7))}>Previous week</button>
      <button type="button" onClick={() => setWeekStart(monday(new Date()))}>This week</button>
      <button type="button" onClick={() => setWeekStart(addDays(weekStart,7))}>Next week</button>
      <button type="button" onClick={() => setReload((x) => x+1)}>Refresh</button>
      <button type="button" onClick={exportCsv} disabled={loading || !rows.length}>Export payroll CSV</button>
    </div>
    <p className={styles.weekLabel}>{weekStart} to {addDays(weekStart,6)} · Monday–Sunday · {rows.length} employees</p>
    <div className={styles.filters}>
      <input aria-label="Search employee" placeholder="Search employee" value={search} onChange={(e) => setSearch(e.target.value)} />
      <select aria-label="Filter company" value={company} onChange={(e) => setCompany(e.target.value)}><option>All</option><option>MAM</option><option>Equipsy</option></select>
      <select aria-label="Filter team" value={team} onChange={(e) => setTeam(e.target.value)}><option>All</option>{teams.map((t)=><option key={t}>{t}</option>)}</select>
      <select aria-label="Filter review status" value={status} onChange={(e) => setStatus(e.target.value)}><option>All</option><option>Has leave</option><option>Needs review</option></select>
    </div>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {loading ? <p role="status">Loading week’s leave and holiday data…</p> : null}
    {!loading && !error && !rows.length ? <p>No employees match this work week and filters.</p> : null}
    <div className={styles.tableWrap}><table><thead><tr><th>Employee</th><th>Team</th><th>Scheduled hours</th><th>Sick / carer’s</th><th>Annual</th><th>Unpaid</th><th>Public holiday (VIC)</th><th>Review</th></tr></thead>
    <tbody>{rows.map((r) => <tr key={r.employee.person_id}>
      <td>{onOpenEmployeeProfile ? <button className={styles.nameLink} type="button" onClick={() => onOpenEmployeeProfile(r.employee.person_id)}>{r.employee.employee_name}</button> : r.employee.employee_name}</td>
      <td>{r.employee.team}</td><td>{r.scheduled === null ? "Unknown" : duration(r.scheduled)}</td>
      <td><CellView cell={r.sick}/></td><td><CellView cell={r.annual}/></td><td><CellView cell={r.unpaid}/></td>
      <td>{r.holiday === null ? "Not assessed" : r.holiday ? duration(r.holiday) + " calendar estimate" : "—"}</td>
      <td>{r.warning.length ? <span className={styles.warning} title={r.warning.join("; ")}>Review ({r.warning.length})</span> : "—"}</td>
    </tr>)}</tbody></table></div>
    <p className={styles.note}>* Estimated from saved working days and hours. Pending, rejected and cancelled leave is shown for review and is not approved payroll. Public holiday hours use the Victorian calendar and saved work schedules, not an employee-specific pay-entitlement determination. Overseas and some remote workers are not assessed. Values are indicative and may exclude breaks, award rules, and overlapping leave: verify before payroll processing. This view does not include actual clocked timesheets.</p>
  </section>;
}
