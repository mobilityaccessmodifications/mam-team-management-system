"use client";

import {
  AlertTriangle,
  Check,
  CheckCircle2,
  FileSpreadsheet,
  LoaderCircle,
  Settings2,
  Upload,
  X,
} from "lucide-react";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  commitPayrollBalanceImport,
  getPayrollBalanceImportAccessWorkspace,
  getPayrollBalanceImportWorkspace,
  getPayrollBalanceImportBatch,
  replacePayrollBalanceImportGrants,
  stagePayrollBalanceFiles,
} from "@/app/payroll-balances/actions";
import { ModalBackdrop } from "@/components/ui/modal-backdrop";
import { useDialogFocus } from "@/components/ui/use-dialog-focus";
import type {
  PayrollImportAccessPerson,
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
  onSaved,
  hideManagementControls = false,
}: {
  onSaved: () => Promise<void>;
  hideManagementControls?: boolean;
}) {
  const [workspace, setWorkspace] = useState<PayrollImportWorkspace | null>();
  const [batch, setBatch] = useState<PayrollImportBatch | null>(null);
  const [busy, setBusy] = useState<"staging" | "committing" | "access" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [accessOpen, setAccessOpen] = useState(false);
  const [accessPeople, setAccessPeople] = useState<PayrollImportAccessPerson[]>([]);
  const [selectedAccess, setSelectedAccess] = useState<Set<string>>(new Set());
  const [accessQuery, setAccessQuery] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewDialogRef = useRef<HTMLElement>(null);
  const previewInitialFocusRef = useRef<HTMLButtonElement>(null);
  const accessDialogRef = useRef<HTMLElement>(null);
  const accessInitialFocusRef = useRef<HTMLInputElement>(null);

  const loadWorkspace = useCallback(async () => {
    try {
      const next = await getPayrollBalanceImportWorkspace();
      setWorkspace(next);
    } catch {
      setWorkspace(null);
    }
  }, []);

  useEffect(() => {
    let active = true;
    startTransition(async () => {
      try {
        const next = await getPayrollBalanceImportWorkspace();
        if (active) setWorkspace(next);
      } catch {
        if (active) setWorkspace(null);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const closePreview = useCallback(() => {
    if (busy !== "committing") setBatch(null);
  }, [busy]);
  const closeAccess = useCallback(() => {
    if (busy !== "access") setAccessOpen(false);
  }, [busy]);

  useDialogFocus(Boolean(batch), previewDialogRef, previewInitialFocusRef, closePreview, fileInputRef);
  useDialogFocus(accessOpen, accessDialogRef, accessInitialFocusRef, closeAccess);

  const stageFiles = async (files: FileList | null) => {
    if (!files?.length || busy) return;
    const formData = new FormData();
    Array.from(files).forEach((file) => formData.append("files", file));
    setBusy("staging");
    setError("");
    setNotice("");
    try {
      const result = await stagePayrollBalanceFiles(formData);
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
    if (!batch || batch.status !== "staged" || busy) return;
    setBusy("committing");
    setError("");
    try {
      const result = await commitPayrollBalanceImport(batch.batchId, batch.version);
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

  const openAccess = async () => {
    if (busy) return;
    setAccessOpen(true);
    setBusy("access");
    setError("");
    setAccessPeople([]);
    setAccessQuery("");
    try {
      const accessWorkspace = await getPayrollBalanceImportAccessWorkspace();
      setAccessPeople(accessWorkspace.people);
      setSelectedAccess(new Set(accessWorkspace.grantedPersonIds));
    } catch {
      setError("Payroll import access could not be loaded. Refresh and try again.");
    } finally {
      setBusy(null);
    }
  };

  const saveAccess = async () => {
    if (busy) return;
    setBusy("access");
    setError("");
    try {
      const result = await replacePayrollBalanceImportGrants(Array.from(selectedAccess));
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setAccessOpen(false);
      setNotice("Payroll import access updated.");
      await loadWorkspace();
    } catch {
      setError("Payroll import access could not be saved. Refresh and try again.");
    } finally {
      setBusy(null);
    }
  };

  const filteredAccessPeople = useMemo(() => {
    const query = accessQuery.trim().toLocaleLowerCase();
    if (!query) return accessPeople;
    return accessPeople.filter((person) => `${person.fullName} ${person.positionTitle}`.toLocaleLowerCase().includes(query));
  }, [accessPeople, accessQuery]);

  const batchSummary = useMemo(() => {
    const rows = batch?.rows ?? [];
    return {
      annual: rows.filter((row) => row.willApplyAnnual).length,
      sick: rows.filter((row) => row.willApplySick).length,
      held: rows.filter((row) => !row.willApplyAnnual && !row.willApplySick).length,
      matched: rows.filter((row) => row.status === "linked").length,
    };
  }, [batch]);

  if (workspace === undefined) {
    return <section className={styles.loading} aria-label="Payroll balance import" aria-busy="true">
      <LoaderCircle className={styles.spinner} size={18} aria-hidden="true" />
      <span>Checking payroll import access…</span>
    </section>;
  }
  if (!workspace) return null;

  const reminder = workspace.reminder;
  return <>
    <section className={styles.workspace} aria-label="Payroll leave balance update">
      <div className={styles.heading}>
        <span className={styles.headingIcon}><FileSpreadsheet size={21} aria-hidden="true" /></span>
        <div>
          <span className={styles.eyebrow}>Monthly payroll update</span>
          <h2>Leave balance upload</h2>
        </div>
        <div className={styles.actions}>
          {workspace.canManageAccess && !hideManagementControls ? <button className={styles.secondaryButton} type="button" onClick={() => void openAccess()} disabled={Boolean(busy)}>
            <Settings2 size={16} aria-hidden="true" />Manage access
          </button> : null}
          <button className={styles.primaryButton} type="button" onClick={() => fileInputRef.current?.click()} disabled={Boolean(busy)}>
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
            <span className={styles.batchStatus} data-status={item.status}>{item.status === "committed" ? "Applied" : "Preview only"}</span>
            <strong>{item.files.map((file) => file.name).join(", ")}</strong>
            <small>{item.rowCount} people · {dateTimeLabel(item.committedAt ?? item.createdAt)}</small>
            <button type="button" className={styles.secondaryButton} onClick={() => {
              void getPayrollBalanceImportBatch(item.batchId).then(setBatch).catch(() => setError("The comparison could not be loaded."));
            }}>View</button>
          </article>)}
        </div>
      </details> : null}
      {error && !batch && !accessOpen ? <p className={styles.error} role="alert">{error}</p> : null}
      {notice && !batch && !accessOpen ? <p className={styles.notice} role="status">{notice}</p> : null}
    </section>

    {batch ? <ModalBackdrop className={styles.modalBackdrop} onClick={closePreview} role="presentation">
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
            <div className={styles.previewHeader} role="row"><span>Employee</span><span>Leave</span><span>Uploaded</span><span>System</span><span>Result</span></div>
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
          {batch.status === "staged" && !batch.comparisonOnly ? <button className={styles.primaryButton} type="button" onClick={() => void commitBatch()} disabled={Boolean(busy)}>
            {busy === "committing" ? <LoaderCircle className={styles.spinner} size={16} aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}
            {busy === "committing" ? "Applying…" : "Apply matched balances"}
          </button> : null}
        </footer>
      </section>
    </ModalBackdrop> : null}

    {accessOpen ? <ModalBackdrop className={styles.modalBackdrop} onClick={closeAccess} role="presentation">
      <section className={styles.accessModal} role="dialog" aria-modal="true" aria-labelledby="payroll-access-title" ref={accessDialogRef} onClick={(event) => event.stopPropagation()}>
        <header>
          <div><span className={styles.eyebrow}>Super Admin</span><h2 id="payroll-access-title">Payroll import access</h2><p>Selected active employees can upload and apply leave balance files.</p></div>
          <button className={styles.iconButton} type="button" aria-label="Close payroll import access" onClick={closeAccess} disabled={busy === "access"}><X size={18} /></button>
        </header>
        <div className={styles.accessBody}>
          {busy === "access" && !accessPeople.length ? <p className={styles.dialogLoading}><LoaderCircle className={styles.spinner} size={18} aria-hidden="true" />Loading employees…</p> : <>
            <label className={styles.searchLabel}>Find employee<input ref={accessInitialFocusRef} type="search" value={accessQuery} onChange={(event) => setAccessQuery(event.currentTarget.value)} placeholder="Name or position" /></label>
            <p className={styles.selectionCount}>{selectedAccess.size} selected</p>
            <div className={styles.accessList}>
              {filteredAccessPeople.map((person) => <label className={styles.accessOption} key={person.personId}>
                <input type="checkbox" checked={selectedAccess.has(person.personId)} disabled={busy === "access"} onChange={(event) => {
                  setSelectedAccess((current) => {
                    const next = new Set(current);
                    if (event.currentTarget.checked) next.add(person.personId);
                    else next.delete(person.personId);
                    return next;
                  });
                }} />
                <span><strong>{person.fullName}</strong><small>{person.positionTitle}</small></span>
              </label>)}
              {!filteredAccessPeople.length ? <p className={styles.empty}>No active employees match that search.</p> : null}
            </div>
          </>}
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
        </div>
        <footer>
          <button className={styles.secondaryButton} type="button" onClick={closeAccess} disabled={busy === "access"}>Cancel</button>
          <button className={styles.primaryButton} type="button" onClick={() => void saveAccess()} disabled={busy === "access" || !accessPeople.length}>{busy === "access" ? "Saving…" : "Save access"}</button>
        </footer>
      </section>
    </ModalBackdrop> : null}
  </>;
}
