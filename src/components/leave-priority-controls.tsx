"use client";

import { useState } from "react";
import { HeartPulse, Palmtree } from "lucide-react";
import { LeaveAccrualControls, LeaveAccrualNotice } from "@/components/leave-accrual-controls";
import { saveAnnualLeaveBalance, saveSickLeaveBalance, saveLeaveBalanceRequiredHours } from "@/app/leave/actions";
import { approvalBalanceCoverage, leaveDateLabel, melbourneToday, type LeavePriorityWorkspace } from "@/lib/leave-priority";
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

export function LeaveSelfServiceControls({ workspace, personId, previewPersonId, busy, onRequest }: {
  workspace?: LeavePriorityWorkspace; personId: string; previewPersonId?: string;
  busy: boolean; onRequest: (personId: string) => void;
}) {
  if (!workspace || (workspace.canManageBalances && !previewPersonId)) return null;
  const ownBalance = workspace.people.find((person) => person.personId === personId && person.canViewBalance && person.paidLeave);
  const team = workspace.people.filter((person) => person.canSubmit);
  if (!ownBalance && !team.length) return null;
  return <div className={styles.leaveSelfService}>
    {ownBalance ? <div><BalanceCard label="My annual leave" hours={ownBalance.hours} /><LeaveAccrualNotice person={ownBalance} /></div> : null}
    {team.length ? <select aria-label="Request leave for a team member" value="" disabled={busy} onChange={(event) => {
      const personId = event.currentTarget.value;
      if (team.some((person) => person.personId === personId)) onRequest(personId);
    }}>
      <option value="" disabled>Request for team</option>
      {team.map((person) => <option value={person.personId} key={person.personId}>{person.name}</option>)}
    </select> : null}
  </div>;
}

export function LeavePriorityControls({ workspace, busy, onRequest, onSaved, previewPersonId }: {
  workspace?: LeavePriorityWorkspace; busy: boolean; previewPersonId?: string;
  onRequest: (personId: string) => void; onSaved: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [balanceType, setBalanceType] = useState<"annual" | "sick">("annual");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  if (!workspace?.canManageBalances || previewPersonId || (!workspace.people.length && !workspace.payrollImports?.length)) return null;
  return <details className={styles.leaveBalances} open>
    <summary>Leave balances{workspace.people.some((p) => p.canSubmit) ? " & team requests" : ""}</summary>
    {workspace.people.map((person) => <div className={styles.leaveBalanceRow} key={person.personId}>
      <div><strong>{person.name}</strong>{person.canViewBalance ? <small>{person.paidLeave ? `Annual: ${person.hours == null ? "Not supplied" : `${balanceHours(person.hours)} hours`}` : "Unpaid leave only"}</small> : null}
        {person.canViewSickBalance ? <small>Sick: {person.sickHours == null ? "Not supplied" : `${balanceHours(person.sickHours)} hours`}</small> : null}
        <LeaveAccrualNotice person={person} />
      </div>
      <div className={styles.leaveBalanceActions}>
        {person.canSubmit ? <button type="button" className={styles.secondaryButton} disabled={busy || saving} onClick={() => onRequest(person.personId)}>Request leave</button> : null}
        {person.paidLeave && person.canViewBalance && workspace.canManageBalances ? <button type="button" className={styles.secondaryButton} disabled={busy || saving} onClick={() => { setEditing(person.personId); setBalanceType("annual"); setError(""); }}>Edit annual</button> : null}
        {person.canViewSickBalance && workspace.canManageBalances ? <button type="button" className={styles.secondaryButton} disabled={busy || saving} onClick={() => { setEditing(person.personId); setBalanceType("sick"); setError(""); }}>Edit sick</button> : null}
      </div>
      {editing === person.personId && person.canViewBalance && workspace.canManageBalances ? <form key={balanceType} className={styles.leaveBalanceEditor} onSubmit={async (event) => {
        event.preventDefault(); if (saving) return;
        const data = new FormData(event.currentTarget);
        setSaving(true); setError("");
        try {
          const result = balanceType === "annual"
            ? await saveAnnualLeaveBalance(person.personId, Number(data.get("hours")), String(data.get("asOf")), false)
            : await saveSickLeaveBalance(person.personId, Number(data.get("hours")), String(data.get("asOf")));
          if (!result.ok) { setError(result.message ?? "Balance could not be saved."); return; }
          await onSaved(); setEditing(null);
        } catch { setError("Balance could not be saved. Please try again."); }
        finally { setSaving(false); }
      }}>
        <label>{balanceType === "annual" ? "Annual" : "Sick"} payroll hours<input name="hours" type="number" step="0.0001" min="-10000" max="100000" defaultValue={(balanceType === "annual" ? (person.annualPayrollHours ?? person.hours) : (person.sickPayrollHours ?? person.sickHours)) ?? ""} required /></label>
        <label>Balance date<input name="asOf" type="date" defaultValue={(balanceType === "annual" ? (person.annualPayrollDate ?? person.asOf) : (person.sickPayrollDate ?? person.sickAsOf)) ?? melbourneToday()} max={melbourneToday()} required /></label>
        <button className={styles.primaryButton} disabled={saving} type="submit">{saving ? "Saving…" : "Save"}</button>
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

export function ApprovalLeaveBalances({ workspace, personId, requestId, busy, onSaved }: {
  workspace?: LeavePriorityWorkspace; personId?: string; requestId: string; busy: boolean; onSaved: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const person = workspace?.people.find((p) => p.personId === personId);
  const request = workspace?.requests.find((r) => r.id === requestId);
  return <section className={styles.approvalBalances} aria-label="Employee leave balances">
    <strong>Leave balances</strong>
    <div className={styles.balanceCards}>
      <BalanceCard label="Annual leave" hours={person?.canViewBalance ? person.hours : null} />
      {person?.canViewSickBalance ? <BalanceCard label="Sick leave" hours={person.sickHours} sick /> : null}
    </div>
    {person ? <LeaveAccrualNotice person={person} /> : null}
    {request?.pendingBalance ? <>
      <p>{request.balanceSufficient ? "Balance sufficient — ready for review." : "Waiting for enough leave. You’ll be notified when the balance is sufficient."}</p>
      <form className={styles.leaveBalanceEditor} onSubmit={async (event) => {
        event.preventDefault(); if (saving || busy) return;
        const hours = Number(new FormData(event.currentTarget).get("requiredHours"));
        setSaving(true); setError("");
        try {
          const result = await saveLeaveBalanceRequiredHours(requestId, hours);
          if (!result.ok) { setError(result.message ?? "Required hours could not be saved."); return; }
          await onSaved();
        } catch { setError("Required hours could not be saved. Please try again."); }
        finally { setSaving(false); }
      }}>
        <label>Paid hours required<input name="requiredHours" type="number" min="0.0001" max="100000" step="0.0001" defaultValue={request.requiredHours ?? ""} required disabled={busy || saving} /></label>
        <button className={styles.secondaryButton} type="submit" disabled={busy || saving}>{saving ? "Saving…" : "Save required hours"}</button>
        {request.requiredHours == null ? <p>Confirm the paid hours for this request to enable the balance reminder.</p> : null}
        {error ? <p role="alert" className={styles.formError}>{error}</p> : null}
      </form>
    </> : null}
  </section>;
}

export function SickEvidenceNotice({ dueDate, hasEvidence }: { dueDate?: string; hasEvidence: boolean }) {
  if (!dueDate || hasEvidence) return null;
  const overdue = melbourneToday() > dueDate;
  return <p className={overdue ? styles.formError : styles.leavePolicyNote} role="note">
    {overdue ? `Medical certificate overdue since ${leaveDateLabel(dueDate)}. Review as Unpaid leave.` : `Upload your medical certificate by Monday ${leaveDateLabel(dueDate)}. If not provided, this leave will need review as Unpaid leave.`}
  </p>;
}

export function ApprovalBalancePill({ workspace, personId, leaveType, requiredHours }: {
  workspace?: LeavePriorityWorkspace; personId?: string; leaveType: string; requiredHours: number | null;
}) {
  const person = workspace?.people.find((p) => p.personId === personId);
  const coverage = approvalBalanceCoverage(person, leaveType, requiredHours);
  return coverage ? <span className={styles.balanceCoverage} data-sufficient={coverage === "Enough balance"}>{coverage}</span> : null;
}
