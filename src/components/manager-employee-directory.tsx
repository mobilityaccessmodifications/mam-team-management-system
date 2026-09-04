"use client";

import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Search,
  UsersRound,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  listManagedEmployeeDirectoryRecordsAction,
  updateManagedEmployeeDirectoryRecord,
} from "@/app/people/manager-actions";
import { EmployeeSelfResources } from "@/components/employee-team-directory";
import styles from "@/components/employee-directory.module.css";
import { MotionLoader } from "@/components/ui/motion-loader";
import { useDialogFocus } from "@/components/ui/use-dialog-focus";
import { useMediaQuery } from "@/components/ui/use-media-query";
import type {
  ManagedEmployeeDirectoryDraft,
  ManagedEmployeeDirectoryRecord,
} from "@/lib/employee-directory-types";
import type { EmployeeItAsset } from "@/lib/it-asset-types";
import type { EmployeeSubscription } from "@/lib/subscription-types";

const recordsPerPage = 8;

export type ManagerEmployeeDirectoryProps = {
  /** System Admin-only Change profile test scope; verified again by every RPC. */
  previewManagerPersonId?: string;
  /** The active manager profile shown alongside their scoped team. */
  managerPersonId?: string;
  /** Refreshes safe organisation data after a manager changes a work record. */
  onRecordsChanged?: () => void | Promise<void>;
  /** Incremented after a safe Realtime directory invalidation. */
  refreshKey?: number;
  /** Safe no-argument self-service loader; never used for a report's records. */
  onLoadMyDevices?: () => Promise<EmployeeItAsset[]>;
  /** Safe no-argument self-service loader; never used for a report's records. */
  onLoadMySubscriptions?: () => Promise<EmployeeSubscription[]>;
};

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toLocaleUpperCase();
}

function companyLabel(company: ManagedEmployeeDirectoryRecord["company"]) {
  return company === "mam" ? "MAM" : "Equipsy";
}

function toDraft(record: ManagedEmployeeDirectoryRecord): ManagedEmployeeDirectoryDraft {
  return {
    firstName: record.firstName,
    lastName: record.lastName,
    workEmail: record.workEmail,
    positionTitle: record.positionTitle,
    teamName: record.teamName,
  };
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return <label>
    <span>{label}{required ? <b aria-hidden="true"> *</b> : null}</span>
    {children}
  </label>;
}

export function ManagerEmployeeDirectory({
  previewManagerPersonId,
  managerPersonId,
  onRecordsChanged,
  refreshKey,
  onLoadMyDevices,
  onLoadMySubscriptions,
}: ManagerEmployeeDirectoryProps) {
  const [records, setRecords] = useState<ManagedEmployeeDirectoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ManagedEmployeeDirectoryDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");
  const editorDialogRef = useRef<HTMLElement>(null);
  const isMobileSheet = useMediaQuery("(max-width: 900px)");

  const loadRecords = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listManagedEmployeeDirectoryRecordsAction(previewManagerPersonId);
      if (!result.ok) {
        setRecords([]);
        setSelectedPersonId(null);
        setDraft(null);
        setLoadError(result.message);
        return;
      }
      const nextRecords = result.records;
      setRecords(nextRecords);
      setSelectedPersonId((current) => (
        current && nextRecords.some((record) => record.personId === current) ? current : null
      ));
      setLoadError("");
    } catch (error) {
      setRecords([]);
      setSelectedPersonId(null);
      setDraft(null);
      setLoadError(error instanceof Error ? error.message : "Team employee records could not be loaded. Refresh and try again.");
    } finally {
      setLoading(false);
    }
  }, [previewManagerPersonId]);

  useEffect(() => {
    // Run after paint so the directory shell stays responsive while the
    // Server Action begins its scoped request.
    const timer = window.setTimeout(() => void loadRecords(), 0);
    return () => window.clearTimeout(timer);
  }, [loadAttempt, loadRecords, refreshKey]);

  const selectedRecord = records.find((record) => record.personId === selectedPersonId) ?? null;
  const selectedRecordIsManager = selectedRecord?.personId === managerPersonId;
  const filteredRecords = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return records.filter((record) => !term || [
      record.fullName,
      record.positionTitle,
      record.teamName,
      record.workEmail,
    ].join(" ").toLocaleLowerCase().includes(term));
  }, [query, records]);

  const openRecord = useCallback((record: ManagedEmployeeDirectoryRecord) => {
    setSelectedPersonId(record.personId);
    setDraft(toDraft(record));
    setSaveError("");
    setNotice("");
  }, []);

  const closeRecord = useCallback(() => {
    if (saving) return;
    setSelectedPersonId(null);
    setDraft(null);
    setSaveError("");
  }, [saving]);

  useDialogFocus(Boolean(selectedRecord && draft) && isMobileSheet, editorDialogRef, null, closeRecord);

  const updateDraft = useCallback((key: keyof ManagedEmployeeDirectoryDraft, value: string) => {
    setDraft((current) => current ? { ...current, [key]: value } : current);
  }, []);

  async function saveRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedRecord || !draft || saving) return;

    setSaving(true);
    setSaveError("");
    setNotice("");
    try {
      const result = await updateManagedEmployeeDirectoryRecord({
        personId: selectedRecord.personId,
        personVersion: selectedRecord.personVersion,
        detailVersion: selectedRecord.detailVersion,
        previewManagerPersonId,
        ...draft,
      });
      setRecords((current) => current.map((record) => (
        record.personId === result.record.personId ? result.record : record
      )));
      setDraft(toDraft(result.record));
      setNotice("Employee record updated.");
      await onRecordsChanged?.();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "This employee record could not be saved. Refresh and try again.");
    } finally {
      setSaving(false);
    }
  }

  return <section className={styles.workspace} aria-label="Team employee directory">
    {notice ? <div className={styles.notice} role="status"><Check size={16} /><span>{notice}</span><button type="button" onClick={() => setNotice("")} aria-label="Dismiss message"><X size={15} /></button></div> : null}

    <div className={styles.directoryDesk}>
      <aside className={styles.directoryList} aria-label="Team employee records">
        <div className={styles.listTools}>
          <label className={styles.searchField}>
            <Search size={17} aria-hidden="true" />
            <span className={styles.visuallyHidden}>Search your team</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onInput={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search your team"
              type="search"
            />
          </label>
        </div>

        {loading ? <div className={styles.listState}><MotionLoader label="Loading team employee records" /></div> : null}
        {!loading && loadError ? <div className={styles.listState} data-error="true"><AlertCircle size={17} /><span>{loadError}</span><button type="button" onClick={() => setLoadAttempt((current) => current + 1)}>Retry</button></div> : null}
        {!loading && !loadError && !filteredRecords.length ? <div className={styles.listState}>No team employees match that search.</div> : null}
        {!loading && !loadError && filteredRecords.length ? <ManagerRecordList
          key={filteredRecords.map((record) => record.personId).join(":")}
          records={filteredRecords}
          selectedPersonId={selectedPersonId}
          onSelect={openRecord}
        /> : null}
      </aside>

      {selectedRecord ? <button className={styles.detailBackdrop} type="button" onClick={closeRecord} aria-label="Close employee record" /> : null}
      {selectedRecord && draft ? <ManagerEmployeeEditor
        dialogRef={editorDialogRef}
        mobileModal={isMobileSheet}
        record={selectedRecord}
        draft={draft}
        readOnly={selectedRecordIsManager}
        saving={saving}
        error={saveError}
        onLoadMyDevices={onLoadMyDevices}
        onLoadMySubscriptions={onLoadMySubscriptions}
        onChange={updateDraft}
        onClose={closeRecord}
        onSubmit={saveRecord}
      /> : <section className={styles.emptyDetail} aria-live="polite">
        <UsersRound size={28} />
        <h3>Select a team member</h3>
      </section>}
    </div>
  </section>;
}

function ManagerRecordList({
  records,
  selectedPersonId,
  onSelect,
}: {
  records: ManagedEmployeeDirectoryRecord[];
  selectedPersonId: string | null;
  onSelect: (record: ManagedEmployeeDirectoryRecord) => void;
}) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(records.length / recordsPerPage));
  const currentPage = Math.min(page, totalPages);
  const firstRecordIndex = (currentPage - 1) * recordsPerPage;
  const paginatedRecords = records.slice(firstRecordIndex, firstRecordIndex + recordsPerPage);

  return <>
    <div className={styles.records}>
      {paginatedRecords.map((record) => <button
        key={record.personId}
        type="button"
        className={styles.recordRow}
        data-selected={selectedPersonId === record.personId}
        data-company={record.company}
        onClick={() => onSelect(record)}
        aria-pressed={selectedPersonId === record.personId}
      >
        <span className={styles.avatar}>{initials(record.fullName)}</span>
        <span className={styles.recordCopy}>
          <strong>{record.fullName}</strong>
          <small>{record.positionTitle}{record.teamName ? ` · ${record.teamName}` : ""}</small>
        </span>
        <span className={styles.recordMeta}><i data-company={record.company}>{companyLabel(record.company)}</i></span>
      </button>)}
    </div>
    <nav className={styles.pagination} aria-label="Team employee list pagination">
      <span className={styles.pageRange} aria-live="polite" aria-atomic="true">Page {currentPage} of {totalPages}</span>
      <div className={styles.paginationControls}>
        <button type="button" className={styles.paginationButton} onClick={() => setPage(Math.max(1, currentPage - 1))} disabled={currentPage === 1} aria-label="Previous page"><ChevronLeft size={15} aria-hidden="true" /></button>
        <button type="button" className={styles.paginationButton} onClick={() => setPage(Math.min(totalPages, currentPage + 1))} disabled={currentPage === totalPages} aria-label="Next page"><ChevronRight size={15} aria-hidden="true" /></button>
      </div>
    </nav>
  </>;
}

function ManagerEmployeeEditor({
  dialogRef,
  mobileModal,
  record,
  draft,
  readOnly,
  saving,
  error,
  onLoadMyDevices,
  onLoadMySubscriptions,
  onChange,
  onClose,
  onSubmit,
}: {
  dialogRef: RefObject<HTMLElement | null>;
  mobileModal: boolean;
  record: ManagedEmployeeDirectoryRecord;
  draft: ManagedEmployeeDirectoryDraft;
  readOnly: boolean;
  saving: boolean;
  error: string;
  onLoadMyDevices?: () => Promise<EmployeeItAsset[]>;
  onLoadMySubscriptions?: () => Promise<EmployeeSubscription[]>;
  onChange: (key: keyof ManagedEmployeeDirectoryDraft, value: string) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return <section className={styles.editor} ref={dialogRef} role={mobileModal ? "dialog" : undefined} aria-modal={mobileModal ? "true" : undefined} aria-label={readOnly ? "View your work directory record" : "Edit team employee record"} tabIndex={mobileModal ? -1 : undefined}>
    <header className={styles.editorHeader}>
      <div>
        <h3>{draft.firstName || record.fullName}</h3>
        <p>{record.positionTitle}{record.managerName ? ` · Reports to ${record.managerName}` : ""}</p>
      </div>
      <button type="button" className={styles.closeButton} onClick={onClose} disabled={saving} aria-label="Close employee record"><X size={18} /></button>
    </header>

    <form onSubmit={onSubmit}>
      {error ? <div className={styles.formError} role="alert"><AlertCircle size={16} /><span>{error}</span></div> : null}
      <fieldset disabled={readOnly}>
        <legend>Work directory details</legend>
        <div className={styles.formGrid}>
          <Field label="First name" required><input value={draft.firstName} onChange={(event) => onChange("firstName", event.target.value)} autoComplete="given-name" required maxLength={80} /></Field>
          <Field label="Last name"><input value={draft.lastName} onChange={(event) => onChange("lastName", event.target.value)} autoComplete="family-name" maxLength={120} /></Field>
          <Field label="Job title" required><input value={draft.positionTitle} onChange={(event) => onChange("positionTitle", event.target.value)} required maxLength={120} /></Field>
          <Field label="Team"><input value={draft.teamName} onChange={(event) => onChange("teamName", event.target.value)} maxLength={120} /></Field>
          <Field label="Work email"><input value={draft.workEmail} onChange={(event) => onChange("workEmail", event.target.value)} type="email" autoComplete="email" maxLength={254} /></Field>
          <Field label="Reports to"><input value={record.managerName || "Not assigned"} readOnly aria-readonly="true" /></Field>
          <Field label="Company"><input value={companyLabel(record.company)} readOnly aria-readonly="true" /></Field>
        </div>
      </fieldset>
      {readOnly ? <EmployeeSelfResources
        key={record.personId}
        personId={record.personId}
        personName={record.fullName}
        onLoadMyDevices={onLoadMyDevices}
        onLoadMySubscriptions={onLoadMySubscriptions}
      /> : null}
      <footer className={styles.formFooter}>
        <div className={styles.formFooterLeft} />
        <div>{readOnly ? <button type="button" className={styles.secondaryAction} onClick={onClose}>Close</button> : <><button type="button" className={styles.secondaryAction} onClick={onClose} disabled={saving}>Cancel</button><button type="submit" className={styles.primaryAction} disabled={saving}>{saving ? "Saving…" : "Save changes"}</button></>}</div>
      </footer>
    </form>
  </section>;
}
