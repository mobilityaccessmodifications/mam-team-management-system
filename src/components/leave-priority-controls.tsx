"use client";

import { useRef, useState } from "react";
import { ChevronDown, HeartPulse, Palmtree } from "lucide-react";
import { LeaveAccrualControls, LeaveAccrualNotice } from "@/components/leave-accrual-controls";
import { saveAnnualLeaveBalance, saveSickLeaveBalance } from "@/app/leave/actions";
import { approvalBalanceCoverage, leaveDateLabel, melbourneToday, type LeavePriorityWorkspace, type LeaveBankSourceKind } from "@/lib/leave-priority";
import type { AnnualLeaveProjection } from "@/lib/leave-request-balance";
import styles from "@/components/leave-demo.module.css";

// Presentation only: balances and approval calculations retain full precision.
function balanceHours(hours: number) {
  if (hours !== 0 && Math.abs(hours) < 0.01) return hours < 0 ? "−<0.01" : "<0.01";
  return new Intl.NumberFormat("en-AU", { maximumFractionDigits: 2 }).format(hours);
}

function BalanceCard({ label, hours, sick = false }: { label: string; hours?: number | null; sick?: boolean }) {
  const Icon = sick ? HeartPulse : Palmtree;
  return <div className={styles.balanceCard} data-kind={sick ? "sick" : "annual"}>
    <span className={styles.balanceIcon}><Icon size={23} strokeWidth={1.7} aria-hidden="true" /></span>
    <div className={styles.balanceCardContent}>
      <span className={styles.balanceCardLabel}>{label}</span>
      {hours == null ? <strong className={styles.balanceUnavailable}>Unavailable</strong>
        : <div className={styles.balanceCardValue} data-negative={hours < 0 || undefined}>
          <strong>{balanceHours(hours)}</strong><span>hours</span>
        </div>}
    </div>
  </div>;
}

function ApprovalBalanceCard({
  label,
  currentHours,
  approvedHours,
  accruedHours,
  retainedHours,
  balanceSource,
  availableHours,
  asOf,
  sick = false,
  requestedHours,
  projection,
}: {
  label: string;
  currentHours?: number | null;
  approvedHours?: number | null;
  accruedHours?: number | null;
  retainedHours?: number | null;
  balanceSource?: "owner_estimate" | "confirmed_usage" | LeaveBankSourceKind | null;
  availableHours?: number | null;
  asOf?: string | null;
  sick?: boolean;
  requestedHours?: number | null;
  projection?: AnnualLeaveProjection | null;
}) {
  const Icon = sick ? HeartPulse : Palmtree;
  const amount = (hours?: number | null, negative = false) => hours == null
    ? <strong className={styles.balanceUnavailable}>Unavailable</strong>
    : <strong data-negative={hours < 0 || undefined}>{balanceHours(negative ? -Math.abs(hours) : hours)} <span>hours</span></strong>;

  return <article className={`${styles.balanceCard} ${styles.balanceBreakdownCard}`} data-kind={sick ? "sick" : "annual"}>
    <header>
      <span className={styles.balanceIcon}><Icon size={21} strokeWidth={1.7} aria-hidden="true" /></span>
      <span><strong>{label}</strong>{asOf ? <small>{balanceSource ? "As at" : "Xero as at"} {leaveDateLabel(asOf)}</small> : null}{balanceSource ? <small>{balanceSource === "owner_estimate" ? "Owner-approved estimate" : balanceSource === "payroll_report" ? "Xero payroll report" : balanceSource === "payslip" ? "Payroll payslip" : balanceSource === "manual_snapshot" ? "Administrator balance" : "Audited payroll reconciliation"}</small> : null}</span>
    </header>
    <dl className={styles.balanceBreakdown}>
      <div><dt>{balanceSource ? "Banked balance" : "Current Xero balance"}</dt><dd>{amount(currentHours)}</dd></div>
      <div><dt>{balanceSource ? "Approved leave after balance date" : "Approved leave in People Hub"}</dt><dd>{amount(approvedHours == null ? null : approvedHours - (retainedHours ?? 0), true)}</dd></div>
      {retainedHours != null && retainedHours > 0 ? <div><dt>Retained unsettled commitment</dt><dd>{amount(retainedHours, true)}</dd></div> : null}
      {!projection && accruedHours != null && accruedHours > 0 ? <div><dt>Eligible accrued leave</dt><dd>{amount(accruedHours)}</dd></div> : null}
      {projection ? <>
        <div><dt>Estimated accrual before leave starts</dt><dd>{amount(projection.accruedHours)}</dd></div>
        {Boolean(projection.otherTakenHours) ? <div><dt>Other confirmed leave taken</dt><dd>{amount(projection.otherTakenHours, true)}</dd></div> : null}
      </> : null}
      <div className={styles.balanceAvailable}><dt>{projection?.status === "projected" ? `Projected available on ${leaveDateLabel(projection.projectedDate)}` : "Available after approved leave"}</dt><dd>{amount(availableHours)}</dd></div>
      {requestedHours !== undefined ? <>
        <div><dt>This request uses</dt><dd>{amount(requestedHours, true)}</dd></div>
        <div className={styles.balanceAvailable}><dt>Remaining after this request</dt><dd>{amount(availableHours == null || requestedHours == null ? null : availableHours - requestedHours)}</dd></div>
      </> : null}
    </dl>
  </article>;
}

export function LeaveRequestBalance({ workspace, personId, requestedHours = null, projection, loading = false, limitGuidance }: {
  workspace?: LeavePriorityWorkspace;
  personId: string;
  self?: boolean;
  requestedHours?: number | null;
  projection?: AnnualLeaveProjection | null;
  loading?: boolean;
  limitGuidance?: string | null;
}) {
  const person = workspace?.people.find((candidate) => (
    candidate.personId === personId
    && candidate.canViewBalance
    && candidate.paidLeave
  ));
  if (!person) return null;

  const availableHours = loading ? null : projection === undefined ? person.annualAvailableHours : projection?.availableHours;
  const summaryAmount = loading ? "Calculating…" : availableHours == null ? "Unavailable" : `${balanceHours(availableHours)} ${availableHours === 1 ? "hour" : "hours"}`;

  return <details key={personId} className={`${styles.requestBalance} ${styles.requestBalanceDisclosure}`}>
    <summary className={styles.requestBalanceSummary}>
      <span className={styles.balanceIcon}><Palmtree size={21} strokeWidth={1.7} aria-hidden="true" /></span>
      <strong>Annual leave balance: <span data-negative={availableHours != null && availableHours < 0 || undefined}>{summaryAmount}</span></strong>
      <ChevronDown className={styles.requestBalanceChevron} size={18} aria-hidden="true" />
    </summary>
    <div className={styles.requestBalanceCalculator}>
    <ApprovalBalanceCard label="Balance breakdown" currentHours={projection === undefined ? person.annualPayrollHours : projection?.payrollHours} approvedHours={projection === undefined ? person.annualApprovedHours : projection?.approvedHours} retainedHours={projection === undefined ? person.annualRetainedHours : projection?.retainedHours} balanceSource={projection === undefined ? person.annualBalanceSource : projection?.balanceSource} availableHours={availableHours} asOf={projection === undefined ? person.annualPayrollDate : projection?.payrollDate} requestedHours={requestedHours} projection={projection} />
    {loading ? <p className={styles.leavePolicyNote} role="status">Calculating projected balance…</p>
      : projection?.status === "projected" ? <>
        <p className={styles.leavePolicyNote}>Projected to the start of {leaveDateLabel(projection.projectedDate)}. Accrual stops on {leaveDateLabel(projection.throughDate!)}. This is an estimate, not a confirmed Xero balance.</p>
        {limitGuidance ? <p className={styles.leaveLimitGuidance}><strong>{limitGuidance}</strong></p> : null}
        <div className={styles.projectionExplanation}>
          <strong>How this is calculated</strong>
          <p>Banked balance + estimated accrual − approved leave after the balance date − retained unsettled commitments − other confirmed usage. All approved commitments remain reserved, including later bookings. Pending requests are not reserved.</p>
          {(projection.terms ?? []).map((term) => <p key={term.fromDate}>
            {leaveDateLabel(term.fromDate)}–{leaveDateLabel(term.throughDate)}: {balanceHours(term.weeklyHours)} ordinary hours/week across {term.weekdays.length} scheduled days. {balanceHours(term.eligibleHours)} eligible hours × {balanceHours(term.annualWeeks)} annual-leave weeks ÷ 52 = {balanceHours(term.accruedHours)} hours.
          </p>)}
          <p>Uses saved, effective-dated work policies. Approved unpaid hours are excluded unless payroll has confirmed different eligible hours; paid leave/public holidays continue scheduled accrual. Employment start/end dates and paused policies are respected. Future changes may alter the estimate. Only completed days before the leave start count.</p>
        </div>
      </> : <p className={styles.leavePolicyNote}>{projection?.status === "banked_only" ? "Future accrual could not be confirmed for this date. Only the displayed banked balance is available; contact payroll to check the snapshot and accrual policy." : "Projection unavailable. Contact payroll or reopen the form to retry."}</p>}
    {!loading && projection?.status === "banked_only" && limitGuidance ? <p className={styles.leaveLimitGuidance}><strong>{limitGuidance}</strong></p> : null}
    </div>
  </details>;
}

export function LeavePriorityControls({ workspace, busy, onRequest, onSaved }: {
  workspace?: LeavePriorityWorkspace; busy: boolean; previewPersonId?: string;
  onRequest: (personId: string) => void; onSaved: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [balanceType, setBalanceType] = useState<"annual" | "sick">("annual");
  const [saving, setSaving] = useState(false);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const mutationFence = useRef(false);
  const [error, setError] = useState("");
  if (!workspace?.canManageBalances || (!workspace.people.length && !workspace.payrollImports?.length)) return null;
  return <details className={styles.leaveBalances} open>
    <summary>Leave balances{workspace.people.some((p) => p.canSubmit) ? " & team requests" : ""}</summary>
    {workspace.people.map((person) => <div className={styles.leaveBalanceRow} key={person.personId}>
      <div><strong>{person.name}</strong>{person.canViewBalance ? person.annualBalanceSource ? <>
        <small>Banked annual: {person.annualPayrollHours == null ? "Unavailable" : `${balanceHours(person.annualPayrollHours)} hours`}</small>
        {person.annualRetainedHours != null && person.annualRetainedHours > 0 ? <small>Retained unsettled annual: {balanceHours(person.annualRetainedHours)} hours</small> : null}
        <small>Annual available after approved leave: {person.annualAvailableHours == null ? "Unavailable" : `${balanceHours(person.annualAvailableHours)} hours`}</small>
        <small>{person.annualBalanceSource === "owner_estimate" ? "Owner-approved estimate" : person.annualBalanceSource === "payroll_report" ? "Xero payroll report" : person.annualBalanceSource === "payslip" ? "Payroll payslip" : person.annualBalanceSource === "manual_snapshot" ? "Administrator balance" : "Audited payroll reconciliation"}</small>
      </> : <small>{person.paidLeave ? `Annual: ${person.hours == null ? "Not supplied" : `${balanceHours(person.hours)} hours`}` : "Unpaid leave only"}</small> : null}
        {person.canViewSickBalance ? person.sickBalanceSource ? <>
          <small>Banked sick: {person.sickPayrollHours == null ? "Unavailable" : `${balanceHours(person.sickPayrollHours)} hours`}</small>
          {person.sickRetainedHours != null && person.sickRetainedHours > 0 ? <small>Retained unsettled sick: {balanceHours(person.sickRetainedHours)} hours</small> : null}
          <small>Sick available after approved leave: {person.sickAvailableHours == null ? "Unavailable" : `${balanceHours(person.sickAvailableHours)} hours`}</small>
          <small>{person.sickBalanceSource === "owner_estimate" ? "Owner-approved estimate" : person.sickBalanceSource === "payroll_report" ? "Xero payroll report" : person.sickBalanceSource === "payslip" ? "Payroll payslip" : person.sickBalanceSource === "manual_snapshot" ? "Administrator balance" : "Audited payroll reconciliation"}</small>
        </> : <small>Sick: {person.sickHours == null ? "Not supplied" : `${balanceHours(person.sickHours)} hours`}</small> : null}
        <LeaveAccrualNotice person={person} />
      </div>
      <div className={styles.leaveBalanceActions}>
        {person.canSubmit ? <button type="button" className={styles.secondaryButton} disabled={busy || saving} onClick={() => onRequest(person.personId)}>Request leave</button> : null}
        {person.paidLeave && person.canViewBalance && workspace.canManageBalances ? <button type="button" className={styles.secondaryButton} disabled={busy || saving} onClick={() => { setEditing(person.personId); setBalanceType("annual"); setError(""); }}>Edit annual</button> : null}
        {person.canViewSickBalance && workspace.canManageBalances ? <button type="button" className={styles.secondaryButton} disabled={busy || saving} onClick={() => { setEditing(person.personId); setBalanceType("sick"); setError(""); }}>Edit sick</button> : null}
      </div>
      {editing === person.personId && person.canViewBalance && workspace.canManageBalances ? <form key={balanceType} className={styles.leaveBalanceEditor} onSubmit={async (event) => {
        event.preventDefault(); if (saving || mutationFence.current) return;
        const data = new FormData(event.currentTarget);
        setSaving(true); setError("");
        try {
          const result = balanceType === "annual"
            ? await saveAnnualLeaveBalance(person.personId, Number(data.get("hours")), String(data.get("asOf")), false)
            : await saveSickLeaveBalance(person.personId, Number(data.get("hours")), String(data.get("asOf")));
          if (result.committed !== false) { mutationFence.current = true; setRefreshRequired(true); }
          if (!result.ok) { setError(result.message ?? "Balance could not be saved."); return; }
          await onSaved(); mutationFence.current = false; setRefreshRequired(false); setEditing(null);
        } catch { mutationFence.current = true; setRefreshRequired(true); setError("Balance result could not be confirmed. Refresh before trying again."); }
        finally { setSaving(false); }
      }}>
        <label>{balanceType === "annual" ? "Annual" : "Sick"} payroll hours<input name="hours" type="number" step="0.0001" min="-10000" max="100000" defaultValue={(balanceType === "annual" ? (person.annualPayrollHours ?? person.hours) : (person.sickPayrollHours ?? person.sickHours)) ?? ""} required /></label>
        <label>Balance date<input name="asOf" type="date" defaultValue={(balanceType === "annual" ? (person.annualPayrollDate ?? person.asOf) : (person.sickPayrollDate ?? person.sickAsOf)) ?? melbourneToday()} max={melbourneToday()} required /></label>
        <button className={styles.primaryButton} disabled={saving || refreshRequired} type="submit">{saving ? "Saving…" : "Save"}</button>
        <button className={styles.secondaryButton} disabled={saving} type="button" onClick={() => setEditing(null)}>Cancel</button>
        {error ? <p role="alert" className={styles.formError}>{error}</p> : null}
      </form> : null}
      {workspace.canManageBalances && person.paidLeave && person.accrualPolicy !== undefined ? <LeaveAccrualControls person={person} busy={busy || saving} onSaved={onSaved} /> : null}
    </div>)}
    {workspace.canManageBalances && workspace.payrollImports?.length ? <details className={styles.payrollImportRegister}>
      <summary>Payroll records · {workspace.payrollImports.length}</summary>
      {workspace.payrollImports.map((row) => <div className={styles.leaveBalanceRow} key={row.id}>
        <div><strong>{row.employeeName}</strong><small>{row.company === "mam" ? "MAM" : "Equipsy"} · As of {leaveDateLabel(row.asOf)}</small>
          <small>Annual: {row.annualHours == null ? "Not supplied" : `${balanceHours(row.annualHours)} hours`} · Sick: {row.sickHours == null ? "Not supplied" : `${balanceHours(row.sickHours)} hours`}</small>
          <small>{row.status === "linked" ? `Linked to ${row.linkedName}` : row.status === "inactive" ? "Retained for inactive employee" : row.status === "company_mismatch" ? "Employee company differs from payroll file" : row.status === "ambiguous" ? "More than one employee has this payroll name" : "Employee match required"}</small>
        </div>
      </div>)}
    </details> : null}
  </details>;
}

export function ApprovalLeaveBalances({ workspace, personId, requestId }: {
  workspace?: LeavePriorityWorkspace; personId?: string; requestId: string; busy: boolean; onSaved: () => Promise<void>;
}) {
  const person = workspace?.people.find((p) => p.personId === personId);
  const request = workspace?.requests.find((r) => r.id === requestId);
  const coverage = approvalBalanceCoverage(person, "Annual leave", request?.requiredHours ?? null, request);
  const annualBreakdown = person && Object.hasOwn(person, "annualApprovedHours") && Object.hasOwn(person, "annualAvailableHours");
  const sickBreakdown = person && Object.hasOwn(person, "sickApprovedHours") && Object.hasOwn(person, "sickAvailableHours");
  return <section className={styles.approvalBalances} aria-label="Employee leave balances">
    <strong>Leave balances</strong>
    <div className={styles.balanceCards}>
      {annualBreakdown
        ? <ApprovalBalanceCard label="Annual leave" accruedHours={person.canViewBalance ? person.annualEarnedHours : null} currentHours={person.canViewBalance ? person.annualPayrollHours : null} approvedHours={person.canViewBalance ? person.annualApprovedHours : null} retainedHours={person.canViewBalance ? person.annualRetainedHours : null} balanceSource={person.canViewBalance ? person.annualBalanceSource : null} availableHours={person.canViewBalance ? person.annualAvailableHours : null} asOf={person.canViewBalance ? person.annualPayrollDate : null} />
        : <BalanceCard label="Annual leave" hours={person?.canViewBalance ? person.hours : null} />}
      {person?.canViewSickBalance ? sickBreakdown
        ? <ApprovalBalanceCard label="Sick leave" currentHours={person.sickPayrollHours} approvedHours={person.sickApprovedHours} retainedHours={person.sickRetainedHours} balanceSource={person.sickBalanceSource} availableHours={person.sickAvailableHours} asOf={person.sickPayrollDate} sick />
        : <BalanceCard label="Sick leave" hours={person.sickHours} sick /> : null}
    </div>
    {person && !annualBreakdown && !sickBreakdown ? <LeaveAccrualNotice person={person} /> : null}
    {request?.pendingBalance ? <p>{coverage === "Enough balance"
      ? "Balance sufficient — ready for review."
      : coverage !== "Not enough balance" ? "Check balance — refresh the request to confirm current coverage."
      : `Waiting for enough leave${request.requiredHours == null ? "" : ` to cover ${balanceHours(request.requiredHours)} hours`}. You’ll be notified when the balance is sufficient.`}</p> : null}
    {request?.pendingBalance ? <p>Conditional approval checks the current balance, including eligible accrued leave, after other approved commitments. {person?.annualBalanceSource ? "The breakdown above separates the banked estimate from unsettled commitments." : "The Xero breakdown above shows the payroll snapshot."}</p> : null}
  </section>;
}

export function SickEvidenceNotice({ dueDate, hasEvidence }: { dueDate?: string; hasEvidence: boolean }) {
  if (!dueDate || hasEvidence) return null;
  const overdue = melbourneToday() > dueDate;
  return <p className={overdue ? styles.formError : styles.leavePolicyNote} role="note">
    {overdue ? `Medical certificate overdue since ${leaveDateLabel(dueDate)}. Review as Unpaid leave.` : `Upload your medical certificate by ${leaveDateLabel(dueDate)}. If not provided, this leave will need review as Unpaid leave.`}
  </p>;
}

export function ApprovalBalancePill({ workspace, personId, requestId, leaveType, requiredHours, pendingBalance = false }: {
  workspace?: LeavePriorityWorkspace; personId?: string; requestId?: string; leaveType: string; requiredHours: number | null; pendingBalance?: boolean;
}) {
  const person = workspace?.people.find((p) => p.personId === personId);
  const request = workspace?.requests.find((candidate) => candidate.id === requestId);
  const coverage = approvalBalanceCoverage(person, leaveType, requiredHours, pendingBalance ? { ...request, pendingBalance: true } : request);
  return coverage ? <span className={styles.balanceCoverage} data-sufficient={coverage === "Enough balance"}>{coverage}</span> : null;
}
