"use client";

import styles from "./mobile-register-tools.module.css";

type Option<Key extends string = string> = { value: Key; label: string };
type Sort<Key extends string> = { key: Key; direction: "ascending" | "descending" };

/** Native phone controls replace the table headers hidden by the card layout. */
export function MobileRegisterTools<SortKey extends string, FilterKey extends string>({
  sort, sortOptions, onSort, filters, onFilter,
}: {
  sort: Sort<SortKey> | null;
  sortOptions: Option<SortKey>[];
  onSort: (value: Sort<SortKey> | null) => void;
  filters: { key: FilterKey; label: string; value: string; options: Option[] }[];
  onFilter: (key: FilterKey, value: string) => void;
}) {
  const count = filters.filter(filter => filter.value).length;
  return <details className={styles.tools}>
    <summary>Sort & filter{count ? <span>{count} active</span> : null}</summary>
    <div className={styles.fields}>
      <label>Sort by<select value={sort?.key ?? ""} onChange={event => {
        const option = sortOptions.find(option => option.value === event.target.value);
        onSort(option ? { key: option.value, direction: sort?.direction ?? "ascending" } : null);
      }}><option value="">Default order</option>{sortOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      {sort ? <label>Order<select value={sort.direction} onChange={event => onSort({ ...sort, direction: event.target.value === "descending" ? "descending" : "ascending" })}><option value="ascending">Ascending</option><option value="descending">Descending</option></select></label> : null}
      {filters.map(filter => <label key={filter.key}>{filter.label}<select value={filter.value} onChange={event => onFilter(filter.key, event.target.value)}><option value="">All</option>{filter.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>)}
    </div>
  </details>;
}
