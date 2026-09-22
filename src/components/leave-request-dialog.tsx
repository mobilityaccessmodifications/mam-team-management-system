import { ChevronDown, UsersRound, X } from "lucide-react";
import { type FormEvent, type RefObject, useEffect, useRef, useState } from "react";
import { previewAnnualLeaveBalance } from "@/app/leave/actions";
import type { LeaveWorkspaceData } from "@/app/leave/actions";
import { LeaveRequestBalance, SickEvidenceNotice } from "@/components/leave-priority-controls";
import { ModalBackdrop } from "@/components/ui/modal-backdrop";
import { useDialogFocus } from "@/components/ui/use-dialog-focus";
import { LEAVE_ATTACHMENT_ACCEPT } from "@/lib/leave-attachments";
import { START_TIME_OPTIONS, END_TIME_OPTIONS } from "@/lib/leave-request-options";
import { sickEvidenceDeadline, type LeavePriorityWorkspace } from "@/lib/leave-priority";
import { getVictorianPublicHolidays } from "@/lib/victorian-public-holidays";
import { LEAVE_NOTICE_MESSAGE, requiresLeaveNotice } from "@/lib/leave-notice";
import { INSUFFICIENT_BALANCE_MESSAGE, UNAVAILABLE_BALANCE_MESSAGE, UNCONFIRMED_ACCRUAL_MESSAGE, requestedLeaveHours, type AnnualLeaveProjection } from "@/lib/leave-request-balance";
import styles from "@/components/leave-demo.module.css";

const VICTORIAN_PUBLIC_HOLIDAY_DATES = new Set(
  getVictorianPublicHolidays([2025, 2026, 2027, 2028]).map(({ date }) => date),
);

// Request data and mutations stay with the role-scoped workspace; this component
// owns only the form presentation and its focus lifecycle.
export function LeaveRequestDialog({
  leaveRequestPersonInitials,
  leaveRequestPersonName,
  requestForPersonId,
  activeProfile,
  teamRequestPeople,
  isMutating,
  canApplyForLeave,
  leavePriority,
  formLeaveType,
  availableLeaveTypes,
  hasPaidLeaveEntitlement,
  employmentType,
  formStartDate,
  formEndDate,
  formError,
  previewPersonId,
  closeLeaveRequestForm,
  changeLeaveRequestPerson,
  submitRequest,
  setFormError,
  setFormLeaveType,
  setFormStartDate,
  setFormEndDate,
}: {
  leaveRequestPersonInitials: string;
  leaveRequestPersonName: string;
  requestForPersonId: string;
  activeProfile: { id: string; team: string };
  teamRequestPeople: LeavePriorityWorkspace["people"];
  isMutating: boolean;
  canApplyForLeave: boolean;
  leavePriority: LeavePriorityWorkspace | undefined;
  formLeaveType: string;
  availableLeaveTypes: LeaveWorkspaceData["availableLeaveTypes"];
  hasPaidLeaveEntitlement: boolean;
  employmentType: LeaveWorkspaceData["employmentType"];
  formStartDate: string;
  formEndDate: string;
  formError: string;
  previewPersonId?: string;
  closeLeaveRequestForm: () => void;
  changeLeaveRequestPerson: (value: string) => void;
  submitRequest: (event: FormEvent<HTMLFormElement>) => void;
  setFormError: (value: string) => void;
  setFormLeaveType: (value: string) => void;
  setFormStartDate: (value: string) => void;
  setFormEndDate: (value: string) => void;
}) {
  const sendButtonRef = useRef<HTMLButtonElement>(null);
  const leaveRequestDialogRef = useRef<HTMLElement>(null);
  const leaveRequestInitialFocusRef = useRef<HTMLSelectElement>(null);
  useDialogFocus(true, leaveRequestDialogRef, leaveRequestInitialFocusRef, closeLeaveRequestForm);
  const requestedTeamMember = teamRequestPeople.find((person) => person.personId === requestForPersonId);
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const balancePerson = leavePriority?.people.find((person) => person.personId === (requestForPersonId || activeProfile.id));
  const requestedHours = requestedLeaveHours(formStartDate, formEndDate, startTime, endTime,
    balancePerson?.requestFullDayHours ?? (employmentType === "full_time" ? 7.6 : 7.5));
  const balanceError = [INSUFFICIENT_BALANCE_MESSAGE, UNAVAILABLE_BALANCE_MESSAGE, UNCONFIRMED_ACCRUAL_MESSAGE].includes(formError);
  const personId = requestForPersonId || activeProfile.id;
  const projectionKey = JSON.stringify([personId, formStartDate, previewPersonId]);
  const [projectionState, setProjectionState] = useState<{ key: string; data: AnnualLeaveProjection | null } | null>(null);
  const projection = projectionState?.key === projectionKey ? projectionState.data : null;
  const projectionLoading = formLeaveType === "Annual leave" && projectionState?.key !== projectionKey;
  useEffect(() => {
    if (formLeaveType !== "Annual leave") return;
    let active = true;
    const timer = setTimeout(() => {
      void previewAnnualLeaveBalance(personId, formStartDate, previewPersonId)
        .then((data) => { if (active) setProjectionState({ key: projectionKey, data }); })
        .catch(() => { if (active) setProjectionState({ key: projectionKey, data: null }); });
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [personId, formStartDate, previewPersonId, projectionKey, formLeaveType]);
  return (
    <>
    <ModalBackdrop className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeLeaveRequestForm()}>
      <section inert={formError === LEAVE_NOTICE_MESSAGE || balanceError} className={styles.modal} ref={leaveRequestDialogRef} role="dialog" aria-modal="true" aria-labelledby="new-request-title" tabIndex={-1}>
        <header><div><h2 id="new-request-title">Request leave</h2></div><button type="button" onClick={closeLeaveRequestForm} aria-label="Close request form"><X size={19} /></button></header>
        <div className={styles.formPerson}>
          <span className={styles.avatarOrange}>{leaveRequestPersonInitials}</span>
          <span className={styles.formPersonCopy}>
            <strong>{leaveRequestPersonName}</strong>
            <small>{requestForPersonId ? "On behalf of your team member" : activeProfile.team}</small>
          </span>
          {teamRequestPeople.length ? (
            <label className={styles.requestPersonPicker}>
              <UsersRound aria-hidden="true" size={15} />
              <span className={styles.srOnly}>Request leave for</span>
              <select
                aria-label="Request leave for"
                disabled={isMutating}
                onChange={(event) => changeLeaveRequestPerson(event.currentTarget.value)}
                title="Change request person"
                value={requestForPersonId}
              >
                {canApplyForLeave ? <option value="">Myself</option> : null}
                {teamRequestPeople.map((person) => (
                  <option key={person.personId} value={person.personId}>{person.name}</option>
                ))}
              </select>
              <ChevronDown aria-hidden="true" size={14} />
            </label>
          ) : null}
        </div>
        {formLeaveType === "Annual leave" ? <LeaveRequestBalance workspace={leavePriority} personId={personId} self={!requestForPersonId} requestedHours={requestedHours} projection={projection} loading={projectionLoading} /> : null}
        <form className={styles.form} onSubmit={(event) => {
          if (requiresLeaveNotice({ employmentType, leaveType: formLeaveType, startDate: formStartDate, onBehalfOf: Boolean(requestForPersonId && requestForPersonId !== activeProfile.id) })) {
            event.preventDefault();
            setFormError(LEAVE_NOTICE_MESSAGE);
            return;
          }
          if (formLeaveType === "Annual leave" && (projectionLoading || !projection || projection.status === "unavailable")) {
            event.preventDefault();
            setFormError(UNAVAILABLE_BALANCE_MESSAGE);
            return;
          }
          const available = projection?.availableHours;
          if (formLeaveType === "Annual leave" && requestedHours != null && available != null && requestedHours > available) {
            event.preventDefault();
            setFormError(projection?.status === "banked_only" ? UNCONFIRMED_ACCRUAL_MESSAGE : INSUFFICIENT_BALANCE_MESSAGE);
            return;
          }
          submitRequest(event);
        }} onChange={() => setFormError("")}>
          <label><span>Leave type</span><select ref={leaveRequestInitialFocusRef} name="leaveType" value={formLeaveType} onChange={(event) => setFormLeaveType(event.target.value)} required>{(requestedTeamMember ? (requestedTeamMember.paidLeave ? ["Annual leave", "Sick leave", "Carer's leave", "Unpaid leave"] : ["Unpaid leave"]).map((value) => ({ value, label: value })) : availableLeaveTypes).map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
          {!requestForPersonId && !hasPaidLeaveEntitlement ? <p className={styles.leavePolicyNote} role="note">
            {employmentType === "abn" ? "ABN" : employmentType === "casual" ? "Casual" : "Unclassified"} employees can record Unpaid leave only.
          </p> : null}
          <div className={styles.formRow}><label><span>Start date</span><input name="startDate" type="date" value={formStartDate} onChange={(event) => { const nextDate = event.target.value; setFormStartDate(nextDate); setFormEndDate(nextDate); }} required /></label><label><span>End date</span><input name="endDate" type="date" min={formStartDate} value={formEndDate} onChange={(event) => setFormEndDate(event.target.value)} required /></label></div>
          {formLeaveType === "Sick leave" ? <SickEvidenceNotice dueDate={sickEvidenceDeadline(formEndDate, VICTORIAN_PUBLIC_HOLIDAY_DATES)} hasEvidence={false} /> : null}
          <details className={styles.timeRange}><summary>Part-day leave</summary><div className={styles.formRow}><label><span>Starts</span><select name="startTime" value={startTime} onChange={(event) => setStartTime(event.target.value)}><option value="">Select time</option>{START_TIME_OPTIONS.map((option) => <option value={option.value} key={`start-${option.value}`}>{option.label}</option>)}</select></label><label><span>Ends</span><select name="endTime" value={endTime} onChange={(event) => setEndTime(event.target.value)}><option value="">Select time</option>{END_TIME_OPTIONS.map((option) => <option value={option.value} key={`end-${option.value}`}>{option.label}</option>)}</select></label></div><p>First and last day only.</p></details>
          <details className={styles.requestExtras}><summary>Note & files</summary>
          <div className={styles.requestExtrasContent}>
            <label><span>Note</span><textarea name="employeeNote" rows={3} /></label>
            <label className={styles.attachmentField}>
              <span>Supporting files <small>Optional</small></span>
              <input className={styles.fileInput} name="attachments" type="file" accept={LEAVE_ATTACHMENT_ACCEPT} multiple disabled={isMutating} />
              <small>PDF or image · up to 10 files, 5 MB each.</small>
            </label>
            <small className={styles.privacyNote}>Visible to your approver and HR.</small>
          </div>
          </details>
          {formError && formError !== LEAVE_NOTICE_MESSAGE ? <p className={styles.formError} role="alert">{formError}</p> : null}
          <footer><button className={styles.secondaryButton} type="button" onClick={closeLeaveRequestForm} disabled={isMutating}>Cancel</button><button ref={sendButtonRef} className={styles.primaryButton} type="submit" disabled={isMutating || projectionLoading}>{isMutating ? "Saving…" : projectionLoading ? "Calculating…" : "Send request"}</button></footer>
        </form>
      </section>
    </ModalBackdrop>
    {formError === LEAVE_NOTICE_MESSAGE || balanceError ? <LeaveNoticeDialog message={formError === INSUFFICIENT_BALANCE_MESSAGE ? `${formError} Projection date: ${formStartDate}. See the balance breakdown and calculation in your request form.` : formError} title={balanceError ? (formError === INSUFFICIENT_BALANCE_MESSAGE ? "Not enough balance" : "Balance unavailable") : "Speak to your manager"} returnFocusRef={sendButtonRef} onClose={() => setFormError("")} /> : null}
    </>
  );
}


function LeaveNoticeDialog({ onClose, returnFocusRef, message, title }: { onClose: () => void; returnFocusRef: RefObject<HTMLButtonElement | null>; message: string; title: string }) {
  const dialogRef = useRef<HTMLElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useDialogFocus(true, dialogRef, buttonRef, onClose, returnFocusRef);
  return <ModalBackdrop className={styles.modalBackdrop} role="presentation">
    <section className={`${styles.modal} ${styles.leaveNoticeDialog}`} ref={dialogRef} role="alertdialog" aria-modal="true" aria-labelledby="leave-notice-title" aria-describedby="leave-notice-message" tabIndex={-1}>
      <header><h2 id="leave-notice-title">{title}</h2></header>
      <p id="leave-notice-message">{message}</p>
      <footer><button ref={buttonRef} type="button" className={styles.primaryButton} onClick={onClose}>Back to request</button></footer>
    </section>
  </ModalBackdrop>;
}
