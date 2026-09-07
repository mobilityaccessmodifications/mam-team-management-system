"use client";

import { useState } from "react";
import { saveAnnualLeaveBalance } from "@/app/leave/actions";
import { leaveDateLabel, melbourneToday, type LeavePriorityWorkspace } from "@/lib/leave-priority";
import styles from "@/components/leave-demo.module.css";

export function LeavePriorityControls({ workspace, busy, onRequest, onSaved }: {
  workspace?: LeavePriorityWorkspace; busy: boolean;
  onRequest: (personId: string) => void; onSaved: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  if (!workspace?.people.length) return null;
  return <details className={styles.leaveBalances}>
    <summary>Annual leave balances{workspace.people.some((p) => p.canSubmit) ? " & team requests" : ""}</summary>
    {workspace.people.map((person) => <div className={styles.leaveBalanceRow} key={person.personId}>
      <div><strong>{person.name}</strong><small>{person.paidLeave ? `${person.hours ?? 0} hours${person.asOf ? ` · As of ${leaveDateLabel(person.asOf)}` : ""}` : "Unpaid leave only"}</small></div>
      <div className={styles.leaveBalanceActions}>
        {person.canSubmit ? <button type="button" className={styles.secondaryButton} disabled={busy || saving} onClick={() => onRequest(person.personId)}>Request leave</button> : null}
        {person.paidLeave && workspace.canManageBalances ? <button type="button" className={styles.secondaryButton} disabled={busy || saving} onClick={() => { setEditing(editing === person.personId ? null : person.personId); setError(""); }}>Edit balance</button> : null}
      </div>
      {editing === person.personId ? <form className={styles.leaveBalanceEditor} onSubmit={async (event) => {
        event.preventDefault(); if (saving) return;
        const data = new FormData(event.currentTarget);
        setSaving(true); setError("");
        try {
          const result = await saveAnnualLeaveBalance(person.personId, Number(data.get("hours")), String(data.get("asOf")), false);
          if (!result.ok) { setError(result.message ?? "Balance could not be saved."); return; }
          await onSaved(); setEditing(null);
        } catch { setError("Balance could not be saved. Please try again."); }
        finally { setSaving(false); }
      }}>
        <label>Hours<input name="hours" type="number" step="0.01" min="-10000" max="100000" defaultValue={person.hours ?? 0} required /></label>
        <label>Balance date<input name="asOf" type="date" defaultValue={person.asOf ?? melbourneToday()} max={melbourneToday()} required /></label>
        <button className={styles.primaryButton} disabled={saving} type="submit">{saving ? "Saving…" : "Save"}</button>
        {error ? <p role="alert" className={styles.formError}>{error}</p> : null}
      </form> : null}
    </div>)}
  </details>;
}

export function SickEvidenceNotice({ dueDate, hasEvidence }: { dueDate?: string; hasEvidence: boolean }) {
  if (!dueDate || hasEvidence) return null;
  const overdue = melbourneToday() > dueDate;
  return <p className={overdue ? styles.formError : styles.leavePolicyNote} role="note">
    {overdue ? `Medical certificate overdue since ${leaveDateLabel(dueDate)}. Review as Unpaid leave.` : `Upload your medical certificate by Monday ${leaveDateLabel(dueDate)}. If not provided, this leave will need review as Unpaid leave.`}
  </p>;
}
