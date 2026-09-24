"use client";

import { AlertCircle, Check, LoaderCircle, X } from "lucide-react";
import { type FormEvent, type RefObject, useCallback, useRef, useState } from "react";

import { approveCheckInEmploymentDecision, recordCheckInReview } from "@/app/check-ins/actions";
import styles from "@/components/check-in-review-outcome-dialog.module.css";
import { ModalBackdrop } from "@/components/ui/modal-backdrop";
import { useDialogFocus } from "@/components/ui/use-dialog-focus";
import type { CheckInReminder, CheckInReviewOutcome } from "@/lib/check-in-register-types";

type ReviewableReminder = Pick<
  CheckInReminder,
  "id" | "milestone" | "dueDate" | "reviewOutcome" | "reviewDate" | "reviewNotes" | "reviewVersion" | "peopleCultureApproved"
>;

const standardOutcomes: Array<{ value: CheckInReviewOutcome; label: string; detail: string }> = [
  { value: "on_track", label: "On track", detail: "No follow-up" },
  { value: "follow_up_required", label: "Follow-up needed", detail: "Manager action" },
  { value: "hr_review_required", label: "HR review before decision", detail: "Notifies People & Culture" },
];

const employmentDecisionOutcomes: Array<{ value: CheckInReviewOutcome; label: string; detail: string }> = [
  { value: "probation_extension_pending_hr", label: "Extend probation", detail: "P&C approval required" },
  { value: "non_confirmation_pending_hr", label: "Do not confirm", detail: "P&C approval required" },
];

function melbourneToday() {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function formatDate(value: string) {
  const parsed = new Date(`${value}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(parsed);
}

export function CheckInReviewOutcomeDialog({
  employeeName,
  milestone,
  reminder,
  canApproveEmploymentDecision = false,
  readOnly = false,
  returnFocusRef,
  onClose,
  onSaved,
}: {
  employeeName: string;
  milestone: string;
  reminder: ReviewableReminder;
  canApproveEmploymentDecision?: boolean;
  readOnly?: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [outcome, setOutcome] = useState<CheckInReviewOutcome>(reminder.reviewOutcome ?? "on_track");
  const [reviewDate, setReviewDate] = useState(reminder.reviewDate ?? melbourneToday());
  const [notes, setNotes] = useState(reminder.reviewNotes);
  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);
  const [peopleCultureApproved, setPeopleCultureApproved] = useState(reminder.peopleCultureApproved);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  const initialFocusRef = useRef<HTMLInputElement>(null);
  const closeWhenReady = useCallback(() => { if (!saving && !approving) onClose(); }, [onClose, saving, approving]);
  const isEmploymentDecision = outcome === "probation_extension_pending_hr" || outcome === "non_confirmation_pending_hr";
  const needsPeopleCultureApproval = reminder.milestone === "6_month" && isEmploymentDecision;
  const outcomes = reminder.milestone === "6_month"
    ? [...standardOutcomes, ...employmentDecisionOutcomes]
    : standardOutcomes;
  useDialogFocus(true, dialogRef, readOnly ? null : initialFocusRef, closeWhenReady, returnFocusRef);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || readOnly) return;
    const cleanNotes = notes.trim();
    if (outcome !== "on_track" && !cleanNotes) {
      setError("Add a short note for an outcome that needs follow-up.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await recordCheckInReview({
        reminderId: reminder.id,
        outcome,
        reviewDate,
        notes: cleanNotes,
        expectedVersion: reminder.reviewVersion,
      });
      await onSaved();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The review outcome could not be saved. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function approveEmploymentDecision() {
    if (approving || saving || !canApproveEmploymentDecision || !needsPeopleCultureApproval || !reminder.reviewVersion) return;
    setApproving(true);
    setError("");
    try {
      await approveCheckInEmploymentDecision({ reminderId: reminder.id, expectedVersion: reminder.reviewVersion });
      setPeopleCultureApproved(true);
      await onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The employment decision could not be approved. Try again.");
    } finally {
      setApproving(false);
    }
  }

  return <ModalBackdrop className={styles.backdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeWhenReady()}>
    <section className={styles.dialog} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="check-in-review-title" tabIndex={-1}>
      <header className={styles.header}>
        <div>
          <p>{employeeName}</p>
          <h2 id="check-in-review-title">Review outcome</h2>
          <span>{milestone} · {formatDate(reminder.dueDate)}</span>
        </div>
        <button type="button" onClick={closeWhenReady} disabled={saving || approving} aria-label="Close review outcome"><X size={19} /></button>
      </header>

      {needsPeopleCultureApproval ? <p className={styles.approvalNotice} role="status">
        {peopleCultureApproved ? "People & Culture approved this decision." : "This decision cannot be communicated until People & Culture approves it."}
      </p> : null}

      <form onSubmit={submit}>
        <fieldset className={styles.fields} disabled={saving || approving || readOnly}>
          <legend>Outcome</legend>
          <div className={styles.outcomes}>
            {outcomes.map((option) => <label className={styles.outcome} data-selected={outcome === option.value} key={option.value}>
              <input
                ref={outcome === option.value ? initialFocusRef : undefined}
                type="radio"
                name="outcome"
                value={option.value}
                checked={outcome === option.value}
                onChange={() => setOutcome(option.value)}
              />
              <span className={styles.check}><Check size={14} aria-hidden="true" /></span>
              <span><strong>{option.label}</strong><small>{option.detail}</small></span>
            </label>)}
          </div>

          <label className={styles.field}>
            <span>Review date</span>
            <input type="date" required max={melbourneToday()} value={reviewDate} onChange={(event) => setReviewDate(event.target.value)} />
          </label>

          <label className={styles.field}>
            <span>Notes {outcome === "on_track" ? <small>Optional</small> : <b>Required</b>}</span>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              required={outcome !== "on_track"}
              maxLength={2000}
              rows={5}
              placeholder={outcome === "on_track" ? "Add notes if needed" : "Record the follow-up needed"}
            />
          </label>
        </fieldset>

        {error ? <p className={styles.error} role="alert"><AlertCircle size={16} />{error}</p> : null}

        <footer className={styles.footer}>
          <button className={styles.secondary} type="button" onClick={closeWhenReady} disabled={saving || approving}>{readOnly ? "Close" : "Cancel"}</button>
          {!readOnly && canApproveEmploymentDecision && needsPeopleCultureApproval && !peopleCultureApproved && reminder.reviewVersion ? <button className={styles.secondary} type="button" onClick={() => void approveEmploymentDecision()} disabled={approving || saving}>
            {approving ? <LoaderCircle className={styles.spinner} size={17} aria-hidden="true" /> : <Check size={17} aria-hidden="true" />}
            {approving ? "Approving…" : "Approve as People & Culture"}
          </button> : null}
          {!readOnly ? <button className={styles.primary} type="submit" disabled={saving}>
            {saving ? <LoaderCircle className={styles.spinner} size={17} aria-hidden="true" /> : <Check size={17} aria-hidden="true" />}
            {saving ? "Saving…" : reminder.reviewOutcome ? "Save changes" : "Save outcome"}
          </button> : null}
        </footer>
      </form>
    </section>
  </ModalBackdrop>;
}
