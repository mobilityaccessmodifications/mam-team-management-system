"use client";

import { ChevronDown, Search, X } from "lucide-react";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import styles from "@/components/employee-picker.module.css";
import type { ItAssetAssignee } from "@/lib/it-asset-types";

function assigneeDescription(assignee: ItAssetAssignee) {
  return [assignee.positionTitle, assignee.teamName]
    .filter(Boolean)
    .join(" · ");
}

function assigneeSearchText(assignee: ItAssetAssignee) {
  return [
    assignee.fullName,
    assignee.positionTitle,
    assignee.teamName,
    assignee.company === "mam" ? "MAM" : "Equipsy",
  ].filter(Boolean).join(" ").toLocaleLowerCase();
}

export function EmployeePicker({
  assignees,
  defaultValue = "",
  value,
  onValueChange,
  id,
  required = true,
  ariaLabel = "Search employees",
  placeholder = "Search by name, role or team",
  disabled = false,
  inputRef,
  name = "assignedPersonId",
}: {
  assignees: ItAssetAssignee[];
  defaultValue?: string;
  value?: string;
  onValueChange?: (personId: string) => void;
  id?: string;
  required?: boolean;
  ariaLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
  name?: string;
}) {
  const pickerRef = useRef<HTMLDivElement>(null);
  const ownInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = inputRef ?? ownInputRef;
  const listboxId = useId();
  const [internalSelectedId, setInternalSelectedId] = useState(defaultValue);
  const selectedId = value ?? internalSelectedId;
  function setSelectedId(personId: string) {
    if (value === undefined) setInternalSelectedId(personId);
    onValueChange?.(personId);
  }
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const selected = assignees.find((assignee) => assignee.personId === selectedId) ?? null;

  const filteredAssignees = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return assignees;
    return assignees.filter((assignee) => assigneeSearchText(assignee).includes(query));
  }, [assignees, search]);

  useEffect(() => {
    searchInputRef.current?.setCustomValidity(required && !selectedId ? "Choose an employee from the results." : "");
  }, [required, selectedId, searchInputRef]);

  useEffect(() => {
    if (!open) return;
    function closeWhenOutside(event: PointerEvent) {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", closeWhenOutside);
    return () => document.removeEventListener("pointerdown", closeWhenOutside);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const option = document.getElementById(`${listboxId}-option-${highlightedIndex}`);
    const list = option?.parentElement;
    if (!option || !list) return;
    // Scroll only the options, not the page or the sheet containing the picker.
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
    }
  }, [highlightedIndex, listboxId, open]);

  function openPicker() {
    if (disabled) return;
    setOpen(true);
    setSearch("");
    setHighlightedIndex(0);
  }

  function choose(assignee: ItAssetAssignee) {
    setSelectedId(assignee.personId);
    setSearch("");
    setOpen(false);
    setHighlightedIndex(0);
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    setSearch(event.currentTarget.value);
    setOpen(true);
    setHighlightedIndex(0);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        openPicker();
        return;
      }
      setHighlightedIndex((index) => Math.min(index + 1, Math.max(filteredAssignees.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter" && open) {
      event.preventDefault();
      if (filteredAssignees.length) choose(filteredAssignees[highlightedIndex] ?? filteredAssignees[0]);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setSearch("");
      setHighlightedIndex(0);
    }
  }

  const inputValue = open ? search : (selected?.fullName ?? "");

  return <div className={styles.picker} ref={pickerRef}>
    <input type="hidden" name={name} value={selectedId} />
    <div className={styles.control} data-open={open}>
      <Search className={styles.searchIcon} size={16} aria-hidden="true" />
      <input
        aria-activedescendant={open && filteredAssignees.length ? `${listboxId}-option-${highlightedIndex}` : undefined}
        aria-autocomplete="list"
        aria-controls={open ? listboxId : undefined}
        aria-describedby={open ? `${listboxId}-selection ${listboxId}-results` : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        aria-required={required}
        required={required && !selectedId}
        id={id}
        autoComplete="off"
        className={styles.input}
        disabled={disabled}
        onChange={handleChange}
        onClick={() => { if (!open) openPicker(); }}
        onFocus={openPicker}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        ref={searchInputRef}
        role="combobox"
        type="text"
        value={inputValue}
      />
      {selected && open ? <button
        aria-label="Clear employee selection"
        className={styles.clearButton}
        disabled={disabled}
        onClick={() => setSelectedId("")}
        type="button"
      ><X size={15} /></button> : null}
      <ChevronDown className={styles.chevron} data-open={open} size={16} aria-hidden="true" />
    </div>
    {open ? <p className={styles.resultCount} id={`${listboxId}-selection`}>
      {selected ? `Current selection: ${selected.fullName}. Choose a result to change it, or press Escape to keep it.` : "Choose an employee from the results."}
    </p> : null}
    <div className={styles.resultCount} id={`${listboxId}-results`} role="status" aria-live="polite" aria-atomic="true" hidden={!open}>
      {open ? filteredAssignees.length ? `${filteredAssignees.length} ${filteredAssignees.length === 1 ? "employee" : "employees"} found.` : "No employees match that search. Change your search or press Escape to keep the current selection." : ""}
    </div>
    {open ? <div className={styles.listbox} id={listboxId} role="listbox" aria-label="Employees">
      {filteredAssignees.length ? filteredAssignees.map((assignee, index) => <button
        aria-selected={assignee.personId === selectedId}
        className={styles.option}
        data-highlighted={index === highlightedIndex}
        id={`${listboxId}-option-${index}`}
        key={assignee.personId}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => choose(assignee)}
        role="option"
        type="button"
      >
        <span className={styles.optionName}>{assignee.fullName}</span>
        <span className={styles.optionMeta}>{assigneeDescription(assignee)}</span>
      </button>) : <p className={styles.empty}>No employees match that search.</p>}
    </div> : null}
  </div>;
}
