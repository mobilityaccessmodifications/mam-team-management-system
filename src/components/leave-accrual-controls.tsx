"use client";

import { useState } from "react";
import { saveLeaveAccrualDay, saveLeaveAccrualPolicy } from "@/app/leave/actions";
import { leaveDateLabel, type LeaveBalancePerson } from "@/lib/leave-priority";
import styles from "@/components/leave-demo.module.css";

export function LeaveAccrualNotice({ person }: { person: LeaveBalancePerson }) {
  if (person.accrualStatus !== "needs_review") return null;
  return <small role="status" className={styles.balanceReviewNotice}>Balance needs checking. Ask HR to confirm.</small>;
}

/** Render only from the real administrator capability, outside employee preview. */
export function LeaveAccrualControls({ person, busy, onSaved }: {
  person: LeaveBalancePerson; busy: boolean; onSaved: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const policy = person.accrualPolicy;
  async function run(save: () => Promise<{ ok: boolean; message?: string }>) {
    if (saving || busy) return;
    setSaving(true); setMessage("");
    try {
      const result = await save();
      if (!result.ok) { setMessage(result.message ?? "Could not save."); return; }
      await onSaved(); setMessage("Saved.");
    } catch { setMessage("Could not save. Please try again."); }
    finally { setSaving(false); }
  }
  return <details className={styles.payrollImportRegister}>
    <summary>Accrual settings & reconciliation</summary>
    <p>{policy?.enabled ? `${policy.weeklyHours} ordinary hours/week · ${policy.annualWeeks} annual weeks · ${policy.personalWeeks} personal/carer's weeks per year.` : "Automatic accrual is not enabled for this employee."}</p>
    <form className={styles.leaveBalanceEditor} onSubmit={(event) => {
      event.preventDefault(); const data = new FormData(event.currentTarget);
      void run(() => saveLeaveAccrualPolicy(person.personId, {
        weeklyHours: Number(data.get("weeklyHours")), annualWeeks: Number(data.get("annualWeeks")),
        personalWeeks: Number(data.get("personalWeeks")), shiftworker: data.has("shiftworker"),
        enabled: data.has("enabled"), note: String(data.get("note")),
      }));
    }}>
      <label>Ordinary hours/week<input name="weeklyHours" type="number" min="0.0001" max="38" step="0.0001" defaultValue={policy?.weeklyHours ?? 38} required /></label>
      <label>Annual weeks/year<input name="annualWeeks" type="number" min="4" max="52" step="0.0001" defaultValue={policy?.annualWeeks ?? 4} required /></label>
      <label>Personal/carer’s weeks/year<input name="personalWeeks" type="number" min="2" max="52" step="0.0001" defaultValue={policy?.personalWeeks ?? 2} required /></label>
      <label><input name="shiftworker" type="checkbox" defaultChecked={policy?.shiftworker ?? false} />Qualifying NES shiftworker (at least 5 annual weeks)</label>
      <label><input name="enabled" type="checkbox" defaultChecked={policy?.enabled ?? false} />Enable accrual</label>
      <label>Policy note<input name="note" maxLength={1000} required placeholder="Confirmed ordinary hours and applicable entitlement" /></label>
      <p>Changes apply from today, or the initial accrual start if later. Ordinary hours use the employee’s saved weekdays, or Monday–Friday when no weekdays are recorded. Include any higher award or contract entitlement. First activation needs opening payroll balances covering yesterday.</p>
      <button type="submit" className={styles.secondaryButton} disabled={busy || saving}>Save accrual settings</button>
    </form>
    <details open={person.accrualStatus === "needs_review"}>
      <summary>Confirm a completed day’s payroll hours{person.accrualReviewDate ? ` · ${leaveDateLabel(person.accrualReviewDate)}` : ""}</summary>
      <p>Enter ordinary service hours eligible for each entitlement and actual paid leave taken. Paid leave usually continues to accrue. Exclude overtime and ordinary unpaid leave; retain qualifying public-holiday, community-service and other applicable service. Sick and carer’s leave share one balance. A newer payroll snapshot can also reconcile these dates.</p>
      <form key={person.accrualReviewDate ?? "day"} className={styles.leaveBalanceEditor} onSubmit={(event) => {
        event.preventDefault(); const data = new FormData(event.currentTarget);
        void run(() => saveLeaveAccrualDay(person.personId, {
          date: String(data.get("date")), annualEligible: Number(data.get("annualEligible")),
          personalEligible: Number(data.get("personalEligible")), annualTaken: Number(data.get("annualTaken")),
          personalTaken: Number(data.get("personalTaken")), note: String(data.get("note")),
        }));
      }}>
        <label>Completed date<input name="date" type="date" defaultValue={person.accrualReviewDate ?? ""} required /></label>
        <label>Hours eligible for annual accrual<input name="annualEligible" type="number" min="0" max="24" step="0.0001" required /></label>
        <label>Hours eligible for personal accrual<input name="personalEligible" type="number" min="0" max="24" step="0.0001" required /></label>
        <label>Annual leave taken (hours)<input name="annualTaken" type="number" min="0" max="24" step="0.0001" required /></label>
        <label>Sick/carer’s leave taken (hours)<input name="personalTaken" type="number" min="0" max="24" step="0.0001" required /></label>
        <label>Reconciliation note<input name="note" maxLength={1000} required /></label>
        <button type="submit" className={styles.secondaryButton} disabled={busy || saving}>Save confirmed hours</button>
      </form>
    </details>
    {message ? <p role="status">{message}</p> : null}
  </details>;
}
