"use client";

import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Mail,
  Plus,
  Search,
  UserPlus,
  UsersRound,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  createEmployeeDirectoryRecord,
  listEmployeeDirectoryRecords,
  updateEmployeeDirectoryRecord,
} from "@/app/people/actions";
import styles from "@/components/employee-directory.module.css";
import type {
  CreateEmployeeDirectoryInput,
  EmployeeDirectoryDraft,
  EmployeeDirectoryRecord,
  UpdateEmployeeDirectoryInput,
} from "@/lib/employee-directory-types";

type EditorState =
  | { mode: "create"; draft: EmployeeDirectoryDraft }
  | { mode: "edit"; personId: string; draft: EmployeeDirectoryDraft };

type DirectorySort = "name" | "startedDate" | "company";

const recordsPerPage = 8;

export type EmployeeDirectoryProps = {
  /**
   * Providing records avoids an extra fetch when the parent already has an
   * authorised HR-directory response. Omitting it loads via the HR-only action.
   */
  initialRecords?: EmployeeDirectoryRecord[];
  /** Supports opening a record from the safe organisation tree without exposing its data there. */
  selectedPersonId?: string | null;
  onSelectedPersonId?: (personId: string | null) => void;
  /** Lets the parent refresh safe organisation-tree data after an HR change. */
  onRecordsChanged?: () => void | Promise<void>;
  /** Increment after a realtime directory event to reload the authorised HR view. */
  refreshKey?: number;
};

const emptyDraft: EmployeeDirectoryDraft = {
  firstName: "",
  lastName: "",
  workEmail: "",
  personalEmail: "",
  phone: "",
  positionTitle: "",
  teamName: "",
  managerId: null,
  country: "",
  address: "",
  dateOfBirth: "",
  startedDate: "",
  scheduledEmploymentEndDate: "",
  laptopSupplied: "",
  laptopId: "",
  mouseId: "",
  keyboardId: "",
  assetTags: [],
  company: "mam",
  isActive: true,
};

function toDraft(record: EmployeeDirectoryRecord): EmployeeDirectoryDraft {
  return {
    firstName: record.firstName,
    lastName: record.lastName,
    workEmail: record.workEmail,
    personalEmail: record.personalEmail,
    phone: record.phone,
    positionTitle: record.positionTitle,
    teamName: record.teamName,
    managerId: record.managerId,
    country: record.country,
    address: record.address,
    dateOfBirth: record.dateOfBirth,
    startedDate: record.startedDate,
    scheduledEmploymentEndDate: record.scheduledEmploymentEndDate,
    laptopSupplied: record.laptopSupplied,
    laptopId: record.laptopId,
    mouseId: record.mouseId,
    keyboardId: record.keyboardId,
    assetTags: record.assetTags,
    company: record.company,
    isActive: record.isActive,
  };
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toLocaleUpperCase();
}

function normalise(value: string) {
  return value.trim().toLocaleLowerCase();
}

function companyLabel(company: EmployeeDirectoryRecord["company"]) {
  return company === "mam" ? "MAM" : "Equipsy";
}

function displayManager(record: EmployeeDirectoryRecord) {
  return record.managerName || "No manager assigned";
}

function compareByName(first: EmployeeDirectoryRecord, second: EmployeeDirectoryRecord) {
  return first.fullName.localeCompare(second.fullName, undefined, { sensitivity: "base" });
}

function compareByStartDateNewest(first: EmployeeDirectoryRecord, second: EmployeeDirectoryRecord) {
  if (first.startedDate && second.startedDate && first.startedDate !== second.startedDate) {
    return second.startedDate.localeCompare(first.startedDate);
  }
  if (first.startedDate) return -1;
  if (second.startedDate) return 1;
  return compareByName(first, second);
}

function compareByCompany(first: EmployeeDirectoryRecord, second: EmployeeDirectoryRecord) {
  const companyComparison = companyLabel(first.company).localeCompare(companyLabel(second.company));
  return companyComparison || compareByName(first, second);
}

function paginationItems(totalPages: number, currentPage: number) {
  if (totalPages <= 9) return Array.from({ length: totalPages }, (_, index) => index + 1);

  const pageNumbers = [...new Set([1, currentPage - 1, currentPage, currentPage + 1, totalPages])]
    .filter((pageNumber) => pageNumber > 0 && pageNumber <= totalPages)
    .sort((first, second) => first - second);

  return pageNumbers.flatMap((pageNumber, index) => {
    const previousPage = pageNumbers[index - 1];
    return previousPage && pageNumber - previousPage > 1
      ? ["ellipsis" as const, pageNumber]
      : [pageNumber];
  });
}

function initialPageForSelectedRecord(
  records: EmployeeDirectoryRecord[],
  selectedPersonId: string | null,
) {
  const selectedIndex = selectedPersonId
    ? records.findIndex((record) => record.personId === selectedPersonId)
    : -1;
  return selectedIndex < 0 ? 1 : Math.floor(selectedIndex / recordsPerPage) + 1;
}

function selectedRecord(
  records: EmployeeDirectoryRecord[],
  editor: EditorState | null,
) {
  if (!editor || editor.mode !== "edit") return null;
  return records.find((record) => record.personId === editor.personId) ?? null;
}

function updateDraft(
  editor: EditorState,
  key: keyof EmployeeDirectoryDraft,
  value: string | string[] | boolean | null,
): EditorState {
  return {
    ...editor,
    draft: {
      ...editor.draft,
      [key]: value,
    },
  } as EditorState;
}

export function EmployeeDirectory({
  initialRecords,
  selectedPersonId,
  onSelectedPersonId,
  onRecordsChanged,
  refreshKey,
}: EmployeeDirectoryProps) {
  const [records, setRecords] = useState<EmployeeDirectoryRecord[]>(initialRecords ?? []);
  const [loading, setLoading] = useState(!initialRecords);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<DirectorySort>("name");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (initialRecords) return;

    let cancelled = false;
    async function loadRecords() {
      setLoading(true);
      setLoadError("");
      try {
        const response = await listEmployeeDirectoryRecords();
        if (!cancelled) setRecords(response);
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "Employee records could not be loaded.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadRecords();
    return () => {
      cancelled = true;
    };
  }, [initialRecords]);

  useEffect(() => {
    if (refreshKey === undefined) return;

    let cancelled = false;
    async function refreshRecords() {
      try {
        const response = await listEmployeeDirectoryRecords();
        if (!cancelled) setRecords(response);
      } catch {
        // The currently displayed authorised data remains usable. A later
        // change will try again, rather than replacing it with an error state.
      }
    }

    void refreshRecords();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const searchedRecords = useMemo(() => {
    const searched = normalise(query);
    if (!searched) return records;
    return records.filter((record) => normalise([
      record.fullName,
      record.positionTitle,
      record.teamName,
      record.managerName,
      record.company,
      record.laptopId,
      record.mouseId,
      record.keyboardId,
      record.assetTags.join(" "),
    ].join(" ")).includes(searched));
  }, [query, records]);

  const sortedRecords = useMemo(() => {
    const next = [...searchedRecords];
    if (sort === "startedDate") return next.sort(compareByStartDateNewest);
    if (sort === "company") return next.sort(compareByCompany);
    return next.sort(compareByName);
  }, [searchedRecords, sort]);

  const activeCount = records.filter((record) => record.isActive).length;
  const externallySelectedRecord = selectedPersonId
    ? records.find((record) => record.personId === selectedPersonId) ?? null
    : null;
  // An optional selected ID lets the safe organisation tree request an HR
  // record without carrying any private fields. Once edited, local state owns
  // the draft so typing is never overwritten by a parent render.
  const activeEditor = externallySelectedRecord
    && (editor?.mode !== "edit" || editor.personId !== externallySelectedRecord.personId)
    ? { mode: "edit" as const, personId: externallySelectedRecord.personId, draft: toDraft(externallySelectedRecord) }
    : editor;
  const currentRecord = selectedRecord(records, activeEditor);
  const selectedDirectoryPersonId = activeEditor?.mode === "edit" ? activeEditor.personId : null;
  const employeeListKey = `${selectedDirectoryPersonId ?? "none"}:${sortedRecords.map((record) => record.personId).join(",")}`;

  function closeEditor() {
    if (saving) return;
    setEditor(null);
    setSaveError("");
    onSelectedPersonId?.(null);
  }

  function openRecord(record: EmployeeDirectoryRecord) {
    setEditor({ mode: "edit", personId: record.personId, draft: toDraft(record) });
    setSaveError("");
    setNotice("");
    onSelectedPersonId?.(record.personId);
  }

  function openCreate() {
    setEditor({ mode: "create", draft: { ...emptyDraft } });
    setSaveError("");
    setNotice("");
    onSelectedPersonId?.(null);
  }

  async function saveRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const editorToSave = editor ?? activeEditor;
    if (!editorToSave || saving) return;

    setSaving(true);
    setSaveError("");
    try {
      let saved: EmployeeDirectoryRecord;
      if (editorToSave.mode === "create") {
        const result = await createEmployeeDirectoryRecord(editorToSave.draft as CreateEmployeeDirectoryInput);
        saved = result.record;
      } else {
        const record = selectedRecord(records, editorToSave);
        if (!record) throw new Error("This record is no longer available. Refresh the directory and try again.");
        const input: UpdateEmployeeDirectoryInput = {
          ...editorToSave.draft,
          personId: record.personId,
          personVersion: record.personVersion,
          detailVersion: record.detailVersion,
        };
        const result = await updateEmployeeDirectoryRecord(input);
        saved = result.record;
      }

      setRecords((current) => {
        const exists = current.some((record) => record.personId === saved.personId);
        const next = exists
          ? current.map((record) => record.personId === saved.personId ? saved : record)
          : [...current, saved];
        return next.sort((first, second) => first.fullName.localeCompare(second.fullName));
      });
      setEditor({ mode: "edit", personId: saved.personId, draft: toDraft(saved) });
      setNotice(editorToSave.mode === "create" ? "Employee record created." : "Employee record saved.");
      onSelectedPersonId?.(saved.personId);
      await onRecordsChanged?.();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Employee details could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={styles.workspace} aria-label="Employee directory">
      <header className={styles.header}>
        <div>
          <h2>Employee directory</h2>
        </div>
        <div className={styles.headerActions}>
          <a className={styles.secondaryAction} href="/people/export">
            <Download size={16} /> Export CSV
          </a>
          <button className={styles.primaryAction} type="button" onClick={openCreate}>
            <UserPlus size={16} /> Add employee
          </button>
        </div>
      </header>

      {notice ? <div className={styles.notice} role="status"><Check size={16} /><span>{notice}</span><button type="button" onClick={() => setNotice("")} aria-label="Dismiss message"><X size={15} /></button></div> : null}

      <div className={styles.directoryDesk}>
        <aside className={styles.directoryList} aria-label="Employee records">
          <div className={styles.listTools}>
            <label className={styles.searchField}>
              <Search size={17} aria-hidden="true" />
              <span className={styles.visuallyHidden}>Search employee records</span>
              <input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
                placeholder="Search name, role, team or manager"
                type="search"
              />
            </label>
            <label className={styles.sortField}>
              <span>Sort</span>
              <select
                value={sort}
                onChange={(event) => {
                  setSort(event.target.value as DirectorySort);
                }}
              >
                <option value="name">Name A–Z</option>
                <option value="startedDate">Start date — newest</option>
                <option value="company">Company</option>
              </select>
            </label>
            <span className={styles.recordCount}><UsersRound size={15} /> {activeCount} active</span>
          </div>

          {loading ? <div className={styles.listState}>Loading employee records…</div> : null}
          {!loading && loadError ? <div className={styles.listState} data-error="true"><AlertCircle size={17} /><span>{loadError}</span></div> : null}
          {!loading && !loadError && !sortedRecords.length ? <div className={styles.listState}>No employee records match that search.</div> : null}

          {!loading && !loadError && sortedRecords.length ? <EmployeeDirectoryList
            key={employeeListKey}
            records={sortedRecords}
            selectedPersonId={selectedDirectoryPersonId}
            onSelect={openRecord}
          /> : null}
        </aside>

        {activeEditor ? <EmployeeEditor
          editor={activeEditor}
          currentRecord={currentRecord}
          records={records}
          saving={saving}
          error={saveError}
          onChange={(key, value) => setEditor((current) => updateDraft(current ?? activeEditor, key, value))}
          onClose={closeEditor}
          onSubmit={saveRecord}
        /> : <EmptyDetail onCreate={openCreate} />}
      </div>
    </section>
  );
}

function EmployeeDirectoryList({
  records,
  selectedPersonId,
  onSelect,
}: {
  records: EmployeeDirectoryRecord[];
  selectedPersonId: string | null;
  onSelect: (record: EmployeeDirectoryRecord) => void;
}) {
  const [page, setPage] = useState(() => initialPageForSelectedRecord(records, selectedPersonId));
  const totalPages = Math.max(1, Math.ceil(records.length / recordsPerPage));
  const currentPage = Math.min(page, totalPages);
  const firstRecordIndex = (currentPage - 1) * recordsPerPage;
  const paginatedRecords = records.slice(firstRecordIndex, firstRecordIndex + recordsPerPage);
  const firstVisibleRecord = firstRecordIndex + 1;
  const lastVisibleRecord = Math.min(firstRecordIndex + recordsPerPage, records.length);
  const pageItems = paginationItems(totalPages, currentPage);

  return <>
    <div className={styles.records}>
      {paginatedRecords.map((record) => {
        const selected = selectedPersonId === record.personId;
        return <button
          key={record.personId}
          type="button"
          className={styles.recordRow}
          data-selected={selected}
          data-company={record.company}
          onClick={() => onSelect(record)}
          aria-pressed={selected}
        >
          <span className={styles.avatar}>{initials(record.fullName)}</span>
          <span className={styles.recordCopy}>
            <strong>{record.fullName}</strong>
            <small>{record.positionTitle}{record.teamName ? ` · ${record.teamName}` : ""}</small>
          </span>
          <span className={styles.recordMeta}>
            <i data-company={record.company}>{companyLabel(record.company)}</i>
            {!record.isActive ? <em>Inactive</em> : null}
          </span>
        </button>;
      })}
    </div>

    <nav className={styles.pagination} aria-label="Employee list pagination">
      <span className={styles.pageRange} aria-live="polite" aria-atomic="true">
        Showing {firstVisibleRecord}–{lastVisibleRecord} of {records.length}
      </span>
      <div className={styles.paginationControls}>
        <button
          type="button"
          className={styles.paginationButton}
          onClick={() => setPage(Math.max(1, currentPage - 1))}
          disabled={currentPage === 1}
          aria-label="Previous page"
          title="Previous page"
        >
          <ChevronLeft size={15} aria-hidden="true" />
        </button>
        {pageItems.map((pageItem, index) => typeof pageItem === "number" ? <button
          key={pageItem}
          type="button"
          className={styles.paginationButton}
          data-current={pageItem === currentPage}
          onClick={() => setPage(pageItem)}
          aria-label={`Page ${pageItem}`}
          aria-current={pageItem === currentPage ? "page" : undefined}
        >
          {pageItem}
        </button> : <span key={`${pageItem}-${index}`} className={styles.paginationEllipsis} aria-hidden="true">…</span>)}
        <button
          type="button"
          className={styles.paginationButton}
          onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
          disabled={currentPage === totalPages}
          aria-label="Next page"
          title="Next page"
        >
          <ChevronRight size={15} aria-hidden="true" />
        </button>
      </div>
    </nav>
  </>;
}

function EmptyDetail({ onCreate }: { onCreate: () => void }) {
  return <section className={styles.emptyDetail} aria-live="polite">
    <UsersRound size={28} />
    <h3>Select an employee</h3>
    <p>Choose a record to review and update the HR details, or add a new employee.</p>
    <button type="button" className={styles.secondaryAction} onClick={onCreate}><Plus size={16} /> Add employee</button>
  </section>;
}

function EmployeeEditor({
  editor,
  currentRecord,
  records,
  saving,
  error,
  onChange,
  onClose,
  onSubmit,
}: {
  editor: EditorState;
  currentRecord: EmployeeDirectoryRecord | null;
  records: EmployeeDirectoryRecord[];
  saving: boolean;
  error: string;
  onChange: (key: keyof EmployeeDirectoryDraft, value: string | string[] | boolean | null) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const managerOptions = records
    .filter((record) => record.isActive && record.personId !== currentRecord?.personId)
    .sort((first, second) => first.fullName.localeCompare(second.fullName));
  const isCreate = editor.mode === "create";

  return <section className={styles.editor} aria-label={isCreate ? "Add employee" : "Edit employee"}>
    <header className={styles.editorHeader}>
      <div>
        <span>{isCreate ? "New employee" : "Employee record"}</span>
        <h3>{isCreate ? "Add employee" : editor.draft.firstName || currentRecord?.fullName || "Employee"}</h3>
        {!isCreate && currentRecord ? <p>{currentRecord.positionTitle} · {displayManager(currentRecord)}</p> : <p>Fields marked required are needed for the directory.</p>}
      </div>
      <button type="button" className={styles.closeButton} onClick={onClose} disabled={saving} aria-label="Close employee record"><X size={18} /></button>
    </header>

    <form onSubmit={onSubmit}>
      {error ? <div className={styles.formError} role="alert"><AlertCircle size={16} /><span>{error}</span></div> : null}

      <fieldset>
        <legend>Directory details</legend>
        <div className={styles.formGrid}>
          <Field label="First name" required>
            <input value={editor.draft.firstName} onChange={(event) => onChange("firstName", event.target.value)} autoComplete="given-name" required maxLength={80} />
          </Field>
          <Field label="Last name">
            <input value={editor.draft.lastName} onChange={(event) => onChange("lastName", event.target.value)} autoComplete="family-name" maxLength={80} />
          </Field>
          <Field label="Job title" required className={styles.fullSpan}>
            <input value={editor.draft.positionTitle} onChange={(event) => onChange("positionTitle", event.target.value)} required maxLength={120} />
          </Field>
          <Field label="Team" required>
            <input value={editor.draft.teamName} onChange={(event) => onChange("teamName", event.target.value)} required maxLength={120} />
          </Field>
          <Field label="Reports to">
            <select value={editor.draft.managerId ?? ""} onChange={(event) => onChange("managerId", event.target.value || null)}>
              <option value="">No manager assigned</option>
              {managerOptions.map((manager) => <option key={manager.personId} value={manager.personId}>{manager.fullName} · {manager.positionTitle}</option>)}
            </select>
          </Field>
          <Field label="Company">
            <select value={editor.draft.company} onChange={(event) => onChange("company", event.target.value)}>
              <option value="mam">MAM</option>
              <option value="equipsy">Equipsy</option>
            </select>
          </Field>
          <label className={styles.statusField}>
            <input checked={editor.draft.isActive} onChange={(event) => onChange("isActive", event.target.checked)} type="checkbox" />
            <span><strong>Active employee</strong><small>Turn off only after their reporting line is resolved.</small></span>
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Contact details</legend>
        <div className={styles.formGrid}>
          <Field label="Work email">
            <input value={editor.draft.workEmail} onChange={(event) => onChange("workEmail", event.target.value)} type="email" autoComplete="email" maxLength={254} />
          </Field>
          <Field label="Personal email">
            <input value={editor.draft.personalEmail} onChange={(event) => onChange("personalEmail", event.target.value)} type="email" autoComplete="email" maxLength={254} />
          </Field>
          <Field label="Phone">
            <input value={editor.draft.phone} onChange={(event) => onChange("phone", event.target.value)} type="tel" autoComplete="tel" maxLength={60} />
          </Field>
          <Field label="Country">
            <input value={editor.draft.country} onChange={(event) => onChange("country", event.target.value)} autoComplete="country-name" maxLength={100} />
          </Field>
          <Field label="Address" className={styles.fullSpan}>
            <textarea value={editor.draft.address} onChange={(event) => onChange("address", event.target.value)} autoComplete="street-address" rows={2} maxLength={500} />
          </Field>
        </div>
      </fieldset>

      <fieldset>
        <legend>Employment dates</legend>
        <div className={styles.formGrid}>
          <Field label="Date of birth">
            <input value={editor.draft.dateOfBirth} onChange={(event) => onChange("dateOfBirth", event.target.value)} type="date" />
          </Field>
          <Field label="Start date">
            <input value={editor.draft.startedDate} onChange={(event) => onChange("startedDate", event.target.value)} type="date" />
          </Field>
          <Field label="Scheduled employment end date" className={styles.fullSpan}>
            <input value={editor.draft.scheduledEmploymentEndDate} onChange={(event) => onChange("scheduledEmploymentEndDate", event.target.value)} type="date" />
          </Field>
        </div>
      </fieldset>

      <fieldset>
        <legend>Equipment and assets</legend>
        <div className={styles.formGrid}>
          <Field label="Laptop supplied">
            <select value={editor.draft.laptopSupplied} onChange={(event) => onChange("laptopSupplied", event.target.value)}>
              <option value="">Not recorded</option>
              <option value="own_laptop">Own laptop</option>
              <option value="mam_laptop">MAM laptop</option>
            </select>
          </Field>
          <Field label="Laptop ID" required={editor.draft.laptopSupplied === "mam_laptop"}>
            <input value={editor.draft.laptopId} onChange={(event) => onChange("laptopId", event.target.value)} required={editor.draft.laptopSupplied === "mam_laptop"} maxLength={120} />
          </Field>
          <Field label="Mouse ID">
            <input value={editor.draft.mouseId} onChange={(event) => onChange("mouseId", event.target.value)} maxLength={120} />
          </Field>
          <Field label="Keyboard ID">
            <input value={editor.draft.keyboardId} onChange={(event) => onChange("keyboardId", event.target.value)} maxLength={120} />
          </Field>
          <Field label="Asset tags" className={styles.fullSpan}>
            <textarea
              value={editor.draft.assetTags.join(", ")}
              onChange={(event) => onChange("assetTags", event.target.value.split(/[,;\n]/).map((tag) => tag.trim()).filter(Boolean))}
              rows={2}
              maxLength={1943}
              placeholder="Separate tags with commas"
            />
          </Field>
        </div>
      </fieldset>

      <footer className={styles.formFooter}>
        <p><Mail size={14} /> The CSV keeps the HR workbook columns, then adds the private equipment audit fields.</p>
        <div>
          <button type="button" className={styles.secondaryAction} onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className={styles.primaryAction} disabled={saving}>{saving ? "Saving…" : isCreate ? "Create employee" : "Save changes"}</button>
        </div>
      </footer>
    </form>
  </section>;
}

function Field({
  label,
  required,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return <label className={className}>
    <span>{label}{required ? <b aria-hidden="true"> *</b> : null}</span>
    {children}
  </label>;
}
