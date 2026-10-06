"use client";

import {
  AlertTriangle,
  Check,
  CheckCircle2,
  FileSpreadsheet,
  LoaderCircle,
  Upload,
  X,
} from "lucide-react";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  commitPayrollBalanceImport,
  getPayrollBalanceImportWorkspace,
  getPayrollBalanceImportBatch,
  stagePayrollBalanceFiles,
} from "@/app/payroll-balances/actions";
import { ModalBackdrop } from "@/components/ui/modal-backdrop";
import { useDialogFocus } from "@/components/ui/use-dialog-focus";
import type {
  PayrollImportBatch,
  PayrollImportMatchStatus,
  PayrollImportWorkspace,
} from "@/lib/payroll-balance-import-types";

import styles from "@/components/payroll-balance-importer.module.css";

const statusCopy: Record<PayrollImportMatchStatus, { label: string; detail: string }> = {
  linked: { label: "Matched", detail: "Unique active employee in the same company" },
  inactive: { label: "Inactive", detail: "The employee record is inactive" },
  unmatched: { label: "No match", detail: "No employee has this payroll name" },
  company_mismatch: { label: "Company differs", detail: "The name exists under another company" },
  ambiguous: { label: "Needs review", detail: "More than one employee has this payroll name" },
};

function dateLabel(value: string | null) {
  if (!value) return "Not updated";
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
}

function dateTimeLabel(value: string) {
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function hoursLabel(value: number | null) {
  if (value === null) return "Not supplied";
  return `${new Intl.NumberFormat("en-AU", { maximumFractionDigits: 4 }).format(value)} h`;
}

function fileSizeLabel(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${Math.ceil(bytes / 1024)} KB`;
}

export function PayrollBalanceImporter({
  comparisonOnly = false,
  previewPersonId,
  onSaved,
}: {
  onSaved: () => Promise<void>;
  comparisonOnly?: boolean;
  previewPersonId?: string;
  hideManagementControls?: boolean;
}) {
  const [workspace, setWorkspace] = useState<PayrollImportWorkspace | null>(null);
  const [workspaceStatus, setWorkspaceStatus] = useState<"loading" | "forbidden" | "error" | "ready">("loading");
  const [workspaceError, setWorkspaceError] = useState("");
  const [batch, setBatch] = useState<PayrollImportBatch | null>(null);
  const [busy, setBusy] = useState<"staging" | "committing" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewDialogRef = useRef<HTMLElement>(null);
  const previewInitialFocusRef = useRef<HTMLButtonElement>(null);
  const workspaceLoadVersion = useRef(0);

  const loadWorkspace = useCallback(async () => {
    const version = ++workspaceLoadVersion.current;
    setWorkspaceStatus("loading");
    setWorkspaceError("");
    try {
      const next = await getPayrollBalanceImportWorkspace(previewPersonId);
      if (version !== workspaceLoadVersion.current) return;
      setWorkspaceStatus(next.status);
      if (next.status === "ready") setWorkspace(next.workspace);
      else if (next.status === "forbidden") {
        setWorkspace(null);
        setBatch(null);
      } else setWorkspaceError(next.message);
    } catch {
      if (version !== workspaceLoadVersion.current) return;
      setWorkspaceStatus("error");
      setWorkspaceError("Payroll balance import could not be loaded. Check your connection and try again.");
    }
  }, [previewPersonId]);

  useEffect(() => {
    startTransition(() => { void loadWorkspace(); });
    return () => {
      workspaceLoadVersion.current += 1;
    };
  }, [loadWorkspace]);

  const closePreview = useCallback(() => {
    if (busy !== "committing") setBatch(null);
  }, [busy]);

  const previewOpen = Boolean(batch) && workspaceStatus !== "forbidden";
  useDialogFocus(previewOpen, previewDialogRef, previewInitialFocusRef, closePreview, fileInputRef);

  const stageFiles = async (files: FileList | null) => {
    if (!files?.length || busy) return;
    const formData = new FormData();
    Array.from(files).forEach((file) => formData.append("files", file));
    setBusy("staging");
    setError("");
    setNotice("");
    try {
      const result = await stagePayrollBalanceFiles(formData, previewPersonId);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setBatch(result.batch);
      await loadWorkspace();
    } catch {
      setError("The files could not be uploaded. Check your connection and try again.");
    } finally {
      setBusy(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const commitBatch = async () => {
    if (comparisonOnly || batch?.comparisonOnly || !batch || batch.status !== "staged" || busy) return;
    setBusy("committing");
    setError("");
    try {
      const result = await commitPayrollBalanceImport(batch.batchId, batch.version, previewPersonId);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setBatch(result.batch);
      setNotice("Payroll balances applied. Held rows remain in the payroll record for review.");
      await loadWorkspace();
      await onSaved();
    } catch {
      setError("The payroll balances could not be applied. Refresh and try again.");
    } finally {
      setBusy(null);
    }
  };

  const batchSummary = useMemo(() => {
    const rows = batch?.rows ?? [];
    return {
      annual: rows.filter((row) => row.willApplyAnnual).length,
      sick: rows.filter((row) => row.willApplySick).length,
      held: rows.filter((row) => !row.willApplyAnnual && !row.willApplySick).length,
      matched: rows.filter((row) => row.status === "linked").length,
    };
  }, [batch]);

  const workspaceFeedback = workspaceStatus === "error" ? <div role="alert" className={styles.error}>
    <p>{workspaceError} {batch ? "Your payroll preview is still available." : ""}</p>
    <button className={styles.secondaryButton} type="button" onClick={() => void loadWorkspace()}>Retry payroll import</button>
  </div> : workspaceStatus === "loading" ? <p role="status">Refreshing payroll import…</p> : null;
  const reminder = workspace?.reminder;
  return <>
    {!workspace && workspaceStatus === "loading" ? <section className={styles.loading} aria-label="Payroll balance import" aria-busy="true">
      <LoaderCircle className={styles.spinner} size={18} aria-hidden="true" />
      <span>Checking payroll import access…</span>
    </section> : null}
    {workspaceStatus === "forbidden" ? <section className={styles.workspace} aria-label="Payroll balance import"><p role="status">You do not have permission to import payroll balances.</p></section> : null}
    {!previewOpen && workspaceStatus === "error" ? workspaceFeedback : null}
    {workspace && reminder ? <section className={styles.workspace} aria-label="Payroll leave balance update" aria-busy={workspaceStatus === "loading"}>
      <div className={styles.heading}>
        <span className={styles.headingIcon}><FileSpreadsheet size={21} aria-hidden="true" /></span>
        <div>
          <span className={styles.eyebrow}>Monthly payroll update</span>
          <h2>Leave balance upload</h2>
        </div>
        <div className={styles.actions}>
          <button className={styles.primaryButton} type="button" onClick={() => fileInputRef.current?.click()} disabled={Boolean(busy) || workspaceStatus !== "ready"}>
            {busy === "staging" ? <LoaderCircle className={styles.spinner} size={16} aria-hidden="true" /> : <Upload size={16} aria-hidden="true" />}
            {busy === "staging" ? "Reading files…" : "Upload CSV or Excel"}
          </button>
          <input
            ref={fileInputRef}
            className={styles.visuallyHidden}
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            multiple
            aria-label="Choose payroll leave balance CSV or Excel files"
            onChange={(event) => void stageFiles(event.currentTarget.files)}
          />
        </div>
      </div>

      <div className={styles.reminder} data-complete={reminder.complete || undefined}>
        {reminder.complete ? <CheckCircle2 size={20} aria-hidden="true" /> : <AlertTriangle size={20} aria-hidden="true" />}
        <div>
          <strong>{reminder.complete ? "This month’s files received" : `Update due ${dateLabel(reminder.dueOn)}`}</strong>
        </div>
        <div className={styles.companyStates}>
          <span data-complete={reminder.mamComplete || undefined}><Check size={13} aria-hidden="true" />MAM · {dateLabel(reminder.mamAsOf)}</span>
          <span data-complete={reminder.equipsyComplete || undefined}><Check size={13} aria-hidden="true" />Equipsy · {dateLabel(reminder.equipsyAsOf)}</span>
        </div>
      </div>

      {workspace.recentBatches.length ? <details className={styles.history}>
        <summary>Recent imports · {workspace.recentBatches.length}</summary>
        <div>
          {workspace.recentBatches.map((item) => <article key={item.batchId}>
            <span className={styles.batchStatus} data-status={item.status}>{item.status === "committed" ? "Applied" : "Saved"}</span>
            <strong>{item.files.map((file) => file.name).join(", ")}</strong>
            <small>{item.rowCount} people · {dateTimeLabel(item.committedAt ?? item.createdAt)}</small>
            <button type="button" className={styles.secondaryButton} onClick={() => {
              void getPayrollBalanceImportBatch(item.batchId, previewPersonId).then(setBatch).catch(() => setError("The comparison could not be loaded."));
            }}>View</button>
          </article>)}
        </div>
      </details> : null}
      {error && !batch ? <p className={styles.error} role="alert">{error}</p> : null}
      {notice && !batch ? <p className={styles.notice} role="status">{notice}</p> : null}
    </section> : null}

    {batch && previewOpen ? <ModalBackdrop className={styles.modalBackdrop} onClick={closePreview} role="presentation">
      <section className={styles.previewModal} role="dialog" aria-modal="true" aria-labelledby="payroll-import-title" ref={previewDialogRef} onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span className={styles.eyebrow}>{batch.comparisonOnly ? "Comparison saved" : batch.status === "committed" ? "Import complete" : "Review before applying"}</span>
            <h2 id="payroll-import-title">Payroll balance preview</h2>
            <p>{batch.files.length} {batch.files.length === 1 ? "file" : "files"} · {batch.rows.length} people</p>
          </div>
          <button ref={previewInitialFocusRef} className={styles.iconButton} type="button" aria-label="Close payroll balance preview" onClick={closePreview} disabled={busy === "committing"}><X size={18} /></button>
        </header>
        <div className={styles.previewBody}>
          {workspaceFeedback}
          {batch.comparisonOnly ? <p role="status">{batch.differenceCount ? `${batch.differenceCount} differences — alert queued for marketing@mobilityaccess.com.au.` : "No differences found."} Balances unchanged.</p> : null}
          {!batch.comparisonOnly ? <div className={styles.summaryGrid}>
            <span><strong>{batchSummary.matched}</strong>Matched people</span>
            <span><strong>{batchSummary.annual}</strong>Annual updates</span>
            <span><strong>{batchSummary.sick}</strong>Sick updates</span>
            <span data-warning={batchSummary.held > 0 || undefined}><strong>{batchSummary.held}</strong>Held rows</span>
          </div> : null}
          <div className={styles.fileList}>
            {batch.files.map((file) => <span key={file.name}><FileSpreadsheet size={15} aria-hidden="true" /><strong>{file.name}</strong><small>{file.employeeRows} rows · {fileSizeLabel(file.sizeBytes)}</small></span>)}
          </div>
          {batch.comparisonOnly ? <div className={styles.previewTable} role="table" aria-label="Payroll comparison">
            <div className={styles.previewHeader} role="row"><span role="columnheader">Employee</span><span role="columnheader">Leave</span><span role="columnheader">Uploaded</span><span role="columnheader">System</span><span role="columnheader">Result</span></div>
            {batch.comparisonRows.map((row) => <div className={styles.previewRow} role="row" key={`${row.rowId}:${row.kind}`}>
              <span role="cell" data-label="Employee"><strong>{row.employeeName}</strong><small>{row.company.toUpperCase()}</small></span>
              <span role="cell" data-label="Leave">{row.kind === "annual" ? "Annual" : "Sick"}</span>
              <span role="cell" data-label="Uploaded">{hoursLabel(row.uploadedHours)}<small>{dateLabel(row.fileAsOf)}</small></span>
              <span role="cell" data-label="System">{hoursLabel(row.systemHours)}<small>After approved leave · baseline {dateLabel(row.systemAsOf)}</small></span>
              <span role="cell" data-label="Result">{row.different ? "Review difference" : "Matches"}</span>
            </div>)}
          </div> : <div className={styles.previewTable} role="table" aria-label="Payroll balance matches">
            <div className={styles.previewHeader} role="row">
              <span role="columnheader">Employee</span><span role="columnheader">Company</span><span role="columnheader">Annual</span><span role="columnheader">Sick</span><span role="columnheader">Match</span>
            </div>
            {batch.rows.map((row) => <div className={styles.previewRow} role="row" key={row.rowId}>
              <span role="cell" data-label="Employee"><strong>{row.employeeName}</strong><small>As at {dateLabel(row.asOf)}</small></span>
              <span role="cell" data-label="Company">{row.company === "mam" ? "MAM" : "Equipsy"}</span>
              <span role="cell" data-label="Annual" data-apply={row.willApplyAnnual || undefined}>{hoursLabel(row.annualHours)}{row.willApplyAnnual ? <small>Will update</small> : null}</span>
              <span role="cell" data-label="Sick" data-apply={row.willApplySick || undefined}>{hoursLabel(row.sickHours)}{row.willApplySick ? <small>Will update</small> : null}</span>
              <span role="cell" data-label="Match"><span className={styles.matchStatus} data-status={row.status}>{statusCopy[row.status].label}</span><small>{row.linkedName ?? statusCopy[row.status].detail}</small></span>
            </div>)}
          </div>}
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
        </div>
        <footer>
          <button className={styles.secondaryButton} type="button" onClick={closePreview} disabled={busy === "committing"}>{batch.status === "committed" ? "Done" : "Cancel"}</button>
          {batch.status === "staged" && !batch.comparisonOnly && !comparisonOnly ? <button className={styles.primaryButton} type="button" onClick={() => void commitBatch()} disabled={Boolean(busy) || workspaceStatus !== "ready"}>
            {busy === "committing" ? <LoaderCircle className={styles.spinner} size={16} aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}
            {busy === "committing" ? "Applying…" : "Apply matched balances"}
          </button> : null}
        </footer>
      </section>
    </ModalBackdrop> : null}
  </>;
}
