"use client";

import { ModalBackdrop } from "@/components/ui/modal-backdrop";

import {
  AlertCircle,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Download,
  Pencil,
  Search,
  Trash2,
  UserPlus,
  UserMinus,
  UsersRound,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useId,
  useRef,
  useState,
} from "react";

import {
  createEmployeeDirectoryRecord,
  archiveEmployeeDirectoryRecord,
  deleteEmployeeDirectoryRecord,
  listEmployeeDirectoryRecords,
  updateEmployeeDirectoryRecord,
} from "@/app/people/actions";
import { EmployeeDeviceAssignments } from "@/components/employee-device-assignments";
import { EMPLOYEE_TEAMS } from "@/lib/employee-teams";
import { EmployeePicker } from "@/components/employee-picker";
import toolbar from "@/components/people-toolbar.module.css";
import styles from "@/components/employee-directory.module.css";
import { MotionLoader } from "@/components/ui/motion-loader";
import { useDialogFocus } from "@/components/ui/use-dialog-focus";
import { useMediaQuery } from "@/components/ui/use-media-query";
import type {
  CreateEmployeeDirectoryInput,
  EmployeeDirectoryDraft,
  EmployeeDirectoryRecord,
  EmployeeWorkingDayTime,
  EmployeeWorkingWeekday,
  UpdateEmployeeDirectoryInput,
} from "@/lib/employee-directory-types";

// Edits keep the record versions their draft was built from, so a refreshed
// list cannot make a stale draft pass the server's concurrency check.
type EditorState =
  | { mode: "create"; draft: EmployeeDirectoryDraft }
  | { mode: "edit"; personId: string; personVersion: number; detailVersion: number; draft: EmployeeDirectoryDraft };

function editEditor(record: EmployeeDirectoryRecord): EditorState {
  return {
    mode: "edit",
    personId: record.personId,
    personVersion: record.personVersion,
    detailVersion: record.detailVersion,
    draft: toDraft(record),
  };
}

type DirectorySort = "name" | "startedDate" | "company";

const recordsPerPage = 8;
const employmentEndReasons = [
  { value: "Resigned", label: "Voluntary resignation" },
  { value: "Terminated", label: "Performance or role fit" },
  { value: "End of contract", label: "End of contract" },
  { value: "Redundant", label: "Redundancy" },
  { value: "Other", label: "Other" },
] as const;
const workingDayOptions = [
  { value: 1, short: "Mon", label: "Monday" },
  { value: 2, short: "Tue", label: "Tuesday" },
  { value: 3, short: "Wed", label: "Wednesday" },
  { value: 4, short: "Thu", label: "Thursday" },
  { value: 5, short: "Fri", label: "Friday" },
  { value: 6, short: "Sat", label: "Saturday" },
  { value: 7, short: "Sun", label: "Sunday" },
] as const satisfies ReadonlyArray<{ value: EmployeeWorkingWeekday; short: string; label: string }>;
const scheduleDateFormatter = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

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
  workingWeekdays: null,
  workingDayTimes: [],
  archiveReason: "",
  employmentType: "",
  contractType: "",
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
    workingWeekdays: record.workingWeekdays,
    workingDayTimes: record.workingDayTimes,
    archiveReason: record.archiveReason,
    employmentType: record.employmentType,
    contractType: record.contractType,
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

function todayIso() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatScheduleDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return "Not set";
  return scheduleDateFormatter.format(new Date(Date.UTC(year, month - 1, day)));
}

function formatWorkTime(value: string) {
  const [hourValue, minute] = value.split(":");
  const hour = Number(hourValue);
  if (!Number.isInteger(hour) || !minute) return value;
  return `${hour % 12 || 12}:${minute} ${hour < 12 ? "am" : "pm"}`;
}

function workdaySummary(
  days: EmployeeWorkingWeekday[] | null,
  times: EmployeeWorkingDayTime[] = [],
) {
  if (!days?.length) return "Work days not set";
  const key = days.join(",");
  const labels = new Map(workingDayOptions.map((day) => [day.value, day.short]));
  const dayLabel = key === "1,2,3,4,5"
    ? "Mon–Fri"
    : key === "1,2,3,4,5,6,7"
      ? "Every day"
      : days.map((day) => labels.get(day)).filter(Boolean).join(", ");
  if (!times.length) return dayLabel;
  const timeLabel = times.map((time) => (
    `${labels.get(time.weekday)} ${formatWorkTime(time.startTime)}–${formatWorkTime(time.endTime)}`
  )).join(", ");
  return `${dayLabel} · ${timeLabel}`;
}

function scheduleDateSummary(startDate: string, plannedEndDate: string) {
  const start = startDate ? `Starts ${formatScheduleDate(startDate)}` : "Start date not set";
  const end = plannedEndDate ? `Ends ${formatScheduleDate(plannedEndDate)}` : "Ongoing";
  return `${start} · ${end}`;
}

function toggleWorkday(
  days: EmployeeWorkingWeekday[] | null,
  day: EmployeeWorkingWeekday,
): EmployeeWorkingWeekday[] | null {
  const selected = days ?? [];
  const next = selected.includes(day)
    ? selected.filter((value) => value !== day)
    : [...selected, day].sort((first, second) => first - second);
  return next.length ? next : null;
}

function updateWorkTime(
  times: EmployeeWorkingDayTime[],
  day: EmployeeWorkingWeekday,
  field: "startTime" | "endTime",
  value: string,
) {
  const current = times.find((time) => time.weekday === day) ?? {
    weekday: day,
    startTime: "",
    endTime: "",
  };
  const next = { ...current, [field]: value };
  if (!next.startTime && !next.endTime) {
    return times.filter((time) => time.weekday !== day);
  }
  return [
    ...times.filter((time) => time.weekday !== day),
    next,
  ].sort((first, second) => first.weekday - second.weekday);
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

function hasUnsavedChanges(
  record: EmployeeDirectoryRecord | null,
  editor: EditorState | null,
) {
  if (!record || !editor || editor.mode !== "edit") return false;
  return JSON.stringify(toDraft(record)) !== JSON.stringify(editor.draft);
}

function updateDraft(
  editor: EditorState,
  key: keyof EmployeeDirectoryDraft,
  value: EmployeeDirectoryDraft[keyof EmployeeDirectoryDraft],
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
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [refreshError, setRefreshError] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<DirectorySort>("name");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");
  const [endDatePrompt, setEndDatePrompt] = useState<{ date: string; reason: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<EmployeeDirectoryRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [directoryFilter, setDirectoryFilter] = useState<"active" | "archived">("active");
  const observedRefreshKey = useRef(refreshKey);
  const endDateDialogRef = useRef<HTMLElement>(null);
  const endDateInputRef = useRef<HTMLInputElement>(null);
  const deleteDialogRef = useRef<HTMLElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const editorDialogRef = useRef<HTMLElement>(null);
  const directorySearchRef = useRef<HTMLInputElement>(null);
  const isMobileSheet = useMediaQuery("(max-width: 900px)");
  const closeEndDatePrompt = useCallback(() => {
    if (archiving) return;
    setEndDatePrompt(null);
    setSaveError("");
  }, [archiving]);
  const closeDeletePrompt = useCallback(() => {
    if (deleting) return;
    setDeleteTarget(null);
    setSaveError("");
  }, [deleting]);

  useDialogFocus(Boolean(endDatePrompt), endDateDialogRef, endDateInputRef, closeEndDatePrompt, editorDialogRef);
  useDialogFocus(Boolean(deleteTarget), deleteDialogRef, deleteCancelRef, closeDeletePrompt);

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
  }, [initialRecords, loadAttempt]);

  useEffect(() => {
    if (refreshKey === undefined) return;
    // The primary loader already fetches the current snapshot on mount. Treat
    // refreshKey only as a later invalidation signal so opening Directory does
    // not issue the same HR-only RPC twice (four times in React development
    // strict mode).
    if (observedRefreshKey.current === refreshKey) return;
    observedRefreshKey.current = refreshKey;

    let cancelled = false;
    async function refreshRecords() {
      try {
        const response = await listEmployeeDirectoryRecords();
        if (!cancelled) {
          setRecords(response);
          setRefreshError("");
        }
      } catch (error) {
        if (!cancelled) {
          setRefreshError(error instanceof Error
            ? error.message
            : "Employee records could not be refreshed. The existing list is still available.");
        }
      }
    }

    void refreshRecords();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const statusRecords = useMemo(
    () => records.filter((record) => directoryFilter === "active" ? record.isActive : !record.isActive),
    [directoryFilter, records],
  );

  const searchedRecords = useMemo(() => {
    const searched = normalise(query);
    if (!searched) return statusRecords;
    return statusRecords.filter((record) => normalise([
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
  }, [query, statusRecords]);

  const sortedRecords = useMemo(() => {
    const next = [...searchedRecords];
    if (sort === "startedDate") return next.sort(compareByStartDateNewest);
    if (sort === "company") return next.sort(compareByCompany);
    return next.sort(compareByName);
  }, [searchedRecords, sort]);

  const externallySelectedRecord = selectedPersonId
    ? records.find((record) => record.personId === selectedPersonId) ?? null
    : null;
  // An optional selected ID lets the safe organisation tree request an HR
  // record without carrying any private fields. Once edited, local state owns
  // the draft so typing is never overwritten by a parent render.
  const activeEditor = externallySelectedRecord
    && (editor?.mode !== "edit" || editor.personId !== externallySelectedRecord.personId)
    ? editEditor(externallySelectedRecord)
    : editor;
  const currentRecord = selectedRecord(records, activeEditor);
  const editorHasUnsavedChanges = hasUnsavedChanges(currentRecord, activeEditor);
  const selectedDirectoryPersonId = activeEditor?.mode === "edit" ? activeEditor.personId : null;
  const employeeListKey = `${selectedDirectoryPersonId ?? "none"}:${sortedRecords.map((record) => record.personId).join(",")}`;

  useDialogFocus(
    Boolean(activeEditor) && isMobileSheet && !endDatePrompt && !deleteTarget,
    editorDialogRef,
    null,
    closeEditor,
    directorySearchRef,
  );

  function closeEditor() {
    if (saving) return;
    setEditor(null);
    setSaveError("");
    onSelectedPersonId?.(null);
  }

  function openRecord(record: EmployeeDirectoryRecord) {
    setEditor(editEditor(record));
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

  function handleDraftChange(
    key: keyof EmployeeDirectoryDraft,
    value: EmployeeDirectoryDraft[keyof EmployeeDirectoryDraft],
  ) {
    const base = editor ?? activeEditor;
    if (!base) return;
    setEditor(updateDraft(base, key, value));
  }

  function handleScheduleChange(
    workingWeekdays: EmployeeWorkingWeekday[] | null,
    workingDayTimes: EmployeeWorkingDayTime[],
  ) {
    const base = editor ?? activeEditor;
    if (!base) return;
    setEditor({
      ...base,
      draft: {
        ...base.draft,
        workingWeekdays,
        workingDayTimes,
      },
    });
  }

  function openEmploymentEndPrompt() {
    const base = editor ?? activeEditor;
    const record = selectedRecord(records, base);
    if (!base || !record || !record.isActive) return;

    setSaveError("");
    setEndDatePrompt({
      date: todayIso(),
      reason: "",
    });
  }

  async function confirmEndDate() {
    const base = editor ?? activeEditor;
    const record = selectedRecord(records, base);
    if (!base || !record || archiving) return;
    if (!endDatePrompt?.date) {
      setSaveError("Choose an employment end date.");
      return;
    }
    if (!endDatePrompt.reason) {
      setSaveError("Select an employment end reason.");
      return;
    }
    if (record.startedDate && endDatePrompt.date < record.startedDate) {
      setSaveError("The end date cannot be before the start date.");
      return;
    }
    setArchiving(true);
    setSaveError("");
    try {
      const result = await archiveEmployeeDirectoryRecord({
        personId: record.personId,
        personVersion: record.personVersion,
        detailVersion: record.detailVersion,
        endDate: endDatePrompt.date,
        reason: endDatePrompt.reason,
      });
      if (!result.ok) {
        setSaveError(result.message);
        return;
      }
      setRecords((current) => current.map((candidate) => candidate.personId === result.record.personId ? result.record : candidate));
      setEditor(editEditor(result.record));
      setEndDatePrompt(null);
      setNotice("Employment ended, portal account disabled and profile archived.");
      setDirectoryFilter("archived");
      await onRecordsChanged?.();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "The employee profile could not be archived.");
    } finally {
      setArchiving(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setSaveError("");
    try {
      const result = await deleteEmployeeDirectoryRecord({
        personId: deleteTarget.personId,
        personVersion: deleteTarget.personVersion,
      });
      if (!result.ok) {
        setSaveError(result.message);
        return;
      }
      setRecords((current) => current.filter((record) => record.personId !== deleteTarget.personId));
      setDeleteTarget(null);
      setEditor(null);
      onSelectedPersonId?.(null);
      setNotice("Profile deleted.");
      await onRecordsChanged?.();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "The employee profile could not be deleted.");
    } finally {
      setDeleting(false);
    }
  }

  async function saveRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const editorToSave = editor ?? activeEditor;
    if (!editorToSave || saving) return;

    setSaving(true);
    setSaveError("");
    try {
      let saved: EmployeeDirectoryRecord;
      let warning: string | undefined;
      if (editorToSave.mode === "create") {
        const result = await createEmployeeDirectoryRecord(editorToSave.draft as CreateEmployeeDirectoryInput);
        saved = result.record;
        warning = result.warning;
      } else {
        const record = selectedRecord(records, editorToSave);
        if (!record) throw new Error("This record is no longer available. Refresh the directory and try again.");
        const input: UpdateEmployeeDirectoryInput = {
          ...editorToSave.draft,
          personId: record.personId,
          personVersion: editorToSave.personVersion,
          detailVersion: editorToSave.detailVersion,
        };
        const result = await updateEmployeeDirectoryRecord(input);
        saved = result.record;
        warning = result.warning;
      }

      setRecords((current) => {
        const exists = current.some((record) => record.personId === saved.personId);
        const next = exists
          ? current.map((record) => record.personId === saved.personId ? saved : record)
          : [...current, saved];
        return next.sort((first, second) => first.fullName.localeCompare(second.fullName));
      });
      setEditor(editEditor(saved));
      if (warning) setSaveError(warning);
      else setNotice(editorToSave.mode === "create" ? "Employee record created." : "Employee record saved.");
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
      <header className={toolbar.toolbar} aria-label="Directory actions">
        <div className={toolbar.controls}>
          <label className={toolbar.search}>
            <Search size={17} aria-hidden="true" />
            <span className={styles.visuallyHidden}>Search employee records</span>
            <input
              ref={directorySearchRef}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              onInput={(event) => {
                // Browsers dispatch `input` (and sometimes only `search`)
                // when the native clear affordance on type="search" is used.
                // Keep the controlled filter in sync with that cleared DOM
                // value so the full directory is restored immediately.
                setQuery(event.currentTarget.value);
              }}
              placeholder="Search employees"
              type="search"
            />
          </label>
          <label className={toolbar.select}>
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
          <label className={toolbar.select}>
            <span>View</span>
            <select value={directoryFilter} onChange={(event) => setDirectoryFilter(event.target.value as "active" | "archived")}>
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </select>
          </label>
        </div>
        <div className={toolbar.actions}>
          <a className={toolbar.button} href="/people/export" aria-label="Export employees" title="Export employees">
            <Download size={16} aria-hidden="true" />
            <span className={styles.visuallyHidden}>Export employees</span>
          </a>
          <button className={toolbar.primary} type="button" onClick={openCreate}>
            <UserPlus size={16} /> Add employee
          </button>
        </div>
      </header>

      {notice ? <div className={styles.notice} role="status"><Check size={16} /><span>{notice}</span><button type="button" onClick={() => setNotice("")} aria-label="Dismiss message"><X size={15} /></button></div> : null}
      {refreshError ? <div className={styles.notice} data-error="true" role="alert"><AlertCircle size={16} /><span>{refreshError}</span><button type="button" onClick={() => setRefreshError("")} aria-label="Dismiss refresh error"><X size={15} /></button></div> : null}

      <div className={styles.directoryDesk}>
        <aside className={styles.directoryList} aria-label="Employee records">

          {loading ? <div className={styles.listState}><MotionLoader label="Loading employee records" /></div> : null}
          {!loading && loadError ? <div className={styles.listState} data-error="true"><AlertCircle size={17} /><span>{loadError}</span><button type="button" onClick={() => setLoadAttempt((current) => current + 1)}>Retry</button></div> : null}
          {!loading && !loadError && !sortedRecords.length ? <div className={styles.listState}>No employee records match that search.</div> : null}

          {!loading && !loadError && sortedRecords.length ? <EmployeeDirectoryList
            key={employeeListKey}
            records={sortedRecords}
            selectedPersonId={selectedDirectoryPersonId}
            onSelect={openRecord}
          /> : null}
        </aside>

        {activeEditor ? <button className={styles.detailBackdrop} type="button" onClick={closeEditor} aria-label="Close employee record" /> : null}
        {activeEditor ? <EmployeeEditor
          key={activeEditor.mode === "edit" ? activeEditor.personId : "create"}
          dialogRef={editorDialogRef}
          mobileModal={isMobileSheet}
          editor={activeEditor}
          currentRecord={currentRecord}
          records={records}
          saving={saving}
          error={saveError}
          onChange={handleDraftChange}
          onScheduleChange={handleScheduleChange}
          onClose={closeEditor}
          onSubmit={saveRecord}
          onRequestArchive={!activeEditor || activeEditor.mode === "create" || !currentRecord || !currentRecord.isActive ? undefined : openEmploymentEndPrompt}
          archiveDisabled={editorHasUnsavedChanges}
          onRequestDelete={!activeEditor || activeEditor.mode === "create" || !currentRecord || currentRecord.isActive ? undefined : () => setDeleteTarget(currentRecord)}
        /> : <EmptyDetail />}
      </div>

      {endDatePrompt ? <ModalBackdrop className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeEndDatePrompt(); }}>
        <section className={styles.modal} ref={endDateDialogRef} role="dialog" aria-modal="true" aria-labelledby="end-date-title" tabIndex={-1}>
          <header className={styles.modalHeader}>
            <div><h3 id="end-date-title">End employment</h3>{currentRecord ? <p>{currentRecord.fullName}</p> : null}</div>
            <button type="button" className={styles.modalClose} onClick={closeEndDatePrompt} disabled={archiving} aria-label="Close"><X size={17} /></button>
          </header>
          <div className={styles.modalBody}>
            <p>This archives the employee and disables sign-in. Return their devices first.</p>
            <label className={styles.modalField}><span>Employment end date <b aria-hidden="true">*</b></span><input ref={endDateInputRef} type="date" value={endDatePrompt.date} onChange={(event) => setEndDatePrompt((current) => current ? { ...current, date: event.target.value } : current)} required /></label>
            <label className={styles.modalField}><span>Reason for leaving <b aria-hidden="true">*</b></span><select value={endDatePrompt.reason} onChange={(event) => setEndDatePrompt((current) => current ? { ...current, reason: event.target.value } : current)} required aria-required="true"><option value="" disabled>Select a reason</option>{employmentEndReasons.map((reason) => <option key={reason.value} value={reason.value}>{reason.label}</option>)}</select></label>
            {saveError ? <p className={styles.modalError} role="alert">{saveError}</p> : null}
          </div>
          <footer className={styles.modalActions}><button type="button" className={styles.secondaryAction} onClick={closeEndDatePrompt} disabled={archiving}>Cancel</button><button type="button" className={styles.dangerAction} onClick={() => void confirmEndDate()} disabled={archiving}><UserMinus size={15} />{archiving ? "Ending employment…" : "End employment & disable account"}</button></footer>
        </section>
      </ModalBackdrop> : null}

      {deleteTarget ? <ModalBackdrop className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDeletePrompt(); }}>
        <section className={styles.modal} ref={deleteDialogRef} role="dialog" aria-modal="true" aria-labelledby="delete-profile-title" tabIndex={-1}>
          <header className={styles.modalHeader}>
            <div><h3 id="delete-profile-title">Delete archived profile?</h3><p>{deleteTarget.fullName}</p></div>
            <button type="button" className={styles.modalClose} onClick={closeDeletePrompt} disabled={deleting} aria-label="Close"><X size={17} /></button>
          </header>
          <div className={styles.modalBody}><p>This permanently removes the archived profile. This cannot be undone.</p>{saveError ? <p className={styles.modalError} role="alert">{saveError}</p> : null}</div>
          <footer className={styles.modalActions}><button ref={deleteCancelRef} type="button" className={styles.secondaryAction} onClick={closeDeletePrompt} disabled={deleting}>Cancel</button><button type="button" className={styles.dangerAction} onClick={() => void confirmDelete()} disabled={deleting}><Trash2 size={15} />{deleting ? "Deleting…" : "Delete permanently"}</button></footer>
        </section>
      </ModalBackdrop> : null}
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
            {!record.isActive ? <em>Archived</em> : null}
          </span>
        </button>;
      })}
    </div>

    <nav className={styles.pagination} aria-label="Employee list pagination">
      <span className={styles.pageRange} aria-live="polite" aria-atomic="true">
        Page {currentPage} of {totalPages}
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

function EmptyDetail() {
  return <section className={styles.emptyDetail} aria-live="polite">
    <UsersRound size={28} />
    <h3>Select an employee</h3>
  </section>;
}

function EmployeeEditor({
  dialogRef,
  mobileModal,
  editor,
  currentRecord,
  records,
  saving,
  error,
  onChange,
  onScheduleChange,
  onClose,
  onSubmit,
  onRequestArchive,
  archiveDisabled,
  onRequestDelete,
}: {
  dialogRef: RefObject<HTMLElement | null>;
  mobileModal: boolean;
  editor: EditorState;
  currentRecord: EmployeeDirectoryRecord | null;
  records: EmployeeDirectoryRecord[];
  saving: boolean;
  error: string;
  onChange: (key: keyof EmployeeDirectoryDraft, value: EmployeeDirectoryDraft[keyof EmployeeDirectoryDraft]) => void;
  onScheduleChange: (
    workingWeekdays: EmployeeWorkingWeekday[] | null,
    workingDayTimes: EmployeeWorkingDayTime[],
  ) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onRequestArchive?: () => void;
  archiveDisabled?: boolean;
  onRequestDelete?: () => void;
}) {
  const managerInputId = useId();
  const managerOptions = records
    .filter((record) => record.isActive && record.personId !== currentRecord?.personId)
    .sort((first, second) => first.fullName.localeCompare(second.fullName));
  const isCreate = editor.mode === "create";
  const [editingSchedule, setEditingSchedule] = useState(isCreate);

  return <section className={styles.editor} ref={dialogRef} role={mobileModal ? "dialog" : undefined} aria-modal={mobileModal ? "true" : undefined} aria-label={isCreate ? "Add employee" : "Edit employee"} tabIndex={-1}>
    <header className={styles.editorHeader}>
      <div>
        <h3>{isCreate ? "Add employee" : editor.draft.firstName || currentRecord?.fullName || "Employee"}</h3>
        {!isCreate && currentRecord ? <p>{currentRecord.positionTitle} · {displayManager(currentRecord)}</p> : null}
      </div>
      <button type="button" className={styles.closeButton} onClick={onClose} disabled={saving} aria-label="Close employee record"><X size={18} /></button>
    </header>

    <form onSubmit={onSubmit} aria-busy={saving}>
      {error ? <div className={styles.formError} role="alert"><AlertCircle size={16} /><span>{error}</span></div> : null}

      <fieldset disabled={saving}>
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
            <select value={editor.draft.teamName} onChange={(event) => onChange("teamName", event.target.value)} required>
              <option value="" disabled>Select a team</option>
              {EMPLOYEE_TEAMS.map((team) => <option key={team} value={team}>{team}</option>)}
            </select>
          </Field>
          <div className={styles.pickerField}>
            <label htmlFor={managerInputId}>Reports to{isCreate && editor.draft.isActive ? <b aria-hidden="true"> *</b> : null}</label>
            <EmployeePicker
              id={managerInputId}
              ariaLabel="Reports to"
              name="managerId"
              assignees={managerOptions}
              value={editor.draft.managerId ?? ""}
              onValueChange={(personId) => onChange("managerId", personId || null)}
              placeholder="No manager assigned"
              required={isCreate && editor.draft.isActive}
              disabled={saving}
            />
          </div>
          <Field label="Company">
            <select value={editor.draft.company} onChange={(event) => onChange("company", event.target.value)}>
              <option value="mam">MAM</option>
              <option value="equipsy">Equipsy</option>
            </select>
          </Field>
        </div>
      </fieldset>

      <fieldset disabled={saving}>
        <legend>Contact details</legend>
        <div className={styles.formGrid}>
          <Field label="Work email">
            <input value={editor.draft.workEmail} onChange={(event) => onChange("workEmail", event.target.value)} type="email" autoComplete="email" maxLength={254} />
          </Field>
          <Field label="Personal email">
            <input value={editor.draft.personalEmail} onChange={(event) => onChange("personalEmail", event.target.value)} type="email" autoComplete="email" maxLength={254} />
          </Field>
          {isCreate && editor.draft.isActive ? <p className={`${styles.fullSpan} ${styles.fieldNote}`}>Enter at least one employee email. The Day 1 welcome email uses both work and personal addresses when both are available.</p> : null}
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

      <fieldset disabled={saving}>
        <legend>Employment</legend>
        <div className={styles.formGrid}>
          <Field label="Date of birth">
            <input value={editor.draft.dateOfBirth} onChange={(event) => onChange("dateOfBirth", event.target.value)} type="date" />
          </Field>
          <Field label="Employment type" required>
            <select value={editor.draft.employmentType} onChange={(event) => onChange("employmentType", event.target.value)} required>
              <option value="" disabled>Select employment type</option>
              <option value="abn">ABN</option>
              <option value="casual">Casual</option>
              <option value="full_time">Full Time</option>
              <option value="part_time">Part Time</option>
            </select>
          </Field>
          <Field label="Contract type">
            <select value={editor.draft.contractType} onChange={(event) => onChange("contractType", event.target.value)}>
              <option value="">Not set</option>
              <option value="permanent">Permanent</option>
              <option value="fixed_term">Fixed-Term</option>
            </select>
          </Field>
          {!editor.draft.isActive ? <Field label="Archive reason" className={styles.fullSpan}>
            <input value={editor.draft.archiveReason} readOnly />
          </Field> : null}
        </div>
      </fieldset>

      <fieldset disabled={saving}>
        <legend>Work schedule</legend>
        <div className={styles.scheduleOverview}>
          <span className={styles.scheduleIcon}><CalendarDays size={18} aria-hidden="true" /></span>
          <span className={styles.scheduleCopy}>
            <strong>{workdaySummary(editor.draft.workingWeekdays, editor.draft.workingDayTimes)}</strong>
            <small>{scheduleDateSummary(editor.draft.startedDate, editor.draft.scheduledEmploymentEndDate)}</small>
          </span>
          <button
            type="button"
            className={styles.scheduleEdit}
            onClick={() => setEditingSchedule((current) => !current)}
            aria-expanded={editingSchedule}
            aria-controls="employee-work-schedule-fields"
          >
            {editingSchedule ? <ChevronUp size={15} aria-hidden="true" /> : <Pencil size={15} aria-hidden="true" />}
            {editingSchedule ? "Hide" : "Edit"}
          </button>
        </div>
        {editingSchedule ? <div className={styles.scheduleFields} id="employee-work-schedule-fields">
          <Field label="Start date" required={isCreate && editor.draft.isActive}>
            <input name="startedDate" value={editor.draft.startedDate} onChange={(event) => onChange("startedDate", event.target.value)} type="date" required={isCreate && editor.draft.isActive} />
          </Field>
          <Field label="Planned end date">
            <input name="scheduledEmploymentEndDate" value={editor.draft.scheduledEmploymentEndDate} onChange={(event) => onChange("scheduledEmploymentEndDate", event.target.value)} type="date" min={editor.draft.startedDate || undefined} />
          </Field>
          <div className={styles.workdayField}>
            <span id="employee-workdays-label">Usual work days</span>
            <div className={styles.workdayPicker} role="group" aria-labelledby="employee-workdays-label">
              {workingDayOptions.map((day) => {
                const selected = editor.draft.workingWeekdays?.includes(day.value) ?? false;
                return <button
                  key={day.value}
                  type="button"
                  className={styles.workdayButton}
                  data-selected={selected}
                  aria-pressed={selected}
                  aria-label={day.label}
                  onClick={() => {
                    const nextDays = toggleWorkday(editor.draft.workingWeekdays, day.value);
                    const nextTimes = selected
                      ? editor.draft.workingDayTimes.filter((time) => time.weekday !== day.value)
                      : editor.draft.workingDayTimes;
                    onScheduleChange(nextDays, nextTimes);
                  }}
                ><span>{day.short}</span>{selected ? <Check size={12} aria-hidden="true" /> : null}</button>;
              })}
            </div>
          </div>
          {editor.draft.workingWeekdays?.length ? <div className={styles.workTimeField}>
            <span>Optional daily times</span>
            <small>Leave both fields blank when exact hours are not fixed.</small>
            <div className={styles.workTimeRows}>
              {workingDayOptions.filter((day) => editor.draft.workingWeekdays?.includes(day.value)).map((day) => {
                const time = editor.draft.workingDayTimes.find((candidate) => candidate.weekday === day.value);
                return <div className={styles.workTimeRow} key={day.value}>
                  <strong>{day.label}</strong>
                  <label>
                    <span>Start</span>
                    <input
                      type="time"
                      step={900}
                      value={time?.startTime ?? ""}
                      onChange={(event) => onScheduleChange(
                        editor.draft.workingWeekdays,
                        updateWorkTime(editor.draft.workingDayTimes, day.value, "startTime", event.target.value),
                      )}
                    />
                  </label>
                  <label>
                    <span>Finish</span>
                    <input
                      type="time"
                      step={900}
                      value={time?.endTime ?? ""}
                      onChange={(event) => onScheduleChange(
                        editor.draft.workingWeekdays,
                        updateWorkTime(editor.draft.workingDayTimes, day.value, "endTime", event.target.value),
                      )}
                    />
                  </label>
                </div>;
              })}
            </div>
          </div> : null}
        </div> : null}
      </fieldset>

      {!isCreate && currentRecord ? <EmployeeDeviceAssignments
        key={currentRecord.personId}
        personId={currentRecord.personId}
        personName={currentRecord.fullName}
      /> : null}

      <footer className={styles.formFooter}>
        {archiveDisabled ? <p className={styles.footerHint} id="save-before-ending-employment">Save changes before ending employment.</p> : null}
        <div>
          {onRequestArchive ? <button type="button" className={styles.dangerAction} onClick={onRequestArchive} disabled={saving || archiveDisabled} aria-describedby={archiveDisabled ? "save-before-ending-employment" : undefined}><UserMinus size={14} /> End employment</button> : null}
          {onRequestDelete ? <button type="button" className={styles.dangerAction} onClick={onRequestDelete} disabled={saving}><Trash2 size={14} /> Delete archived profile</button> : null}
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
