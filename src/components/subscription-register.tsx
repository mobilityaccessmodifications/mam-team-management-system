"use client";

import { ModalBackdrop } from "@/components/ui/modal-backdrop";
import { MobileRegisterTools } from "@/components/ui/mobile-register-tools";

import {
  AlertCircle,
  ArrowDownUp,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  CreditCard,
  Filter,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  UsersRound,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  createSubscription,
  listSubscriptionPeople,
  listSubscriptions,
  markSubscriptionReviewed,
  updateSubscription,
} from "@/app/subscriptions/actions";
import { patchSubscription } from "@/app/subscriptions/bulk-actions";
import { runSubscriptionBulkEdit, type SubscriptionBulkPatch, type SubscriptionBulkResult } from "@/lib/subscription-bulk";
import { listSubscriptionCredentialCatalogue } from "@/app/subscription-credentials/actions";
import { EmployeePicker } from "@/components/employee-picker";
import { subscriptionReviewWindow } from "@/lib/subscription-review-date";
import { subscriptionEditorSnapshot, unavailableSubscriptionMemberIds } from "@/lib/subscription-editor-state";
import {
  SubscriptionCredentialAccessDialog,
  SubscriptionCredentialEditor,
} from "@/components/subscription-credential-vault";
import { useDialogFocus } from "@/components/ui/use-dialog-focus";
import toolbar from "@/components/people-toolbar.module.css";
import styles from "@/components/subscription-register.module.css";
import {
  SUBSCRIPTION_BILLING_CYCLES,
  SUBSCRIPTION_COMPANIES,
  subscriptionCompanyLabel,
  subscriptionCountLabel,
  matchesSubscriptionCategory,
  type SubscriptionCompany,
  compareSubscriptionMonthlyCost,
  subscriptionMonthlyEquivalentCents,
  type CreateSubscriptionInput,
  type Subscription,
  type SubscriptionBillingCycle,
  type SubscriptionPerson,
  type SubscriptionPricingModel,
  type UpdateSubscriptionInput,
} from "@/lib/subscription-types";

type RegisterState =
  | { state: "loading" }
  | { state: "ready"; subscriptions: Subscription[] }
  | { state: "error"; message: string };

type SortDirection = "ascending" | "descending";
type SubscriptionSortKey = "service" | "monthly" | "seats" | "nextBilling" | "lastReviewed" | "nextReview" | "responsible" | "status" | "members";
type SubscriptionFilterKey = "pricing" | "company" | "billing" | "nextReview" | "responsible" | "status";
const emptySubscriptionFilters: Record<SubscriptionFilterKey, string> = { pricing: "", company: "", billing: "", nextReview: "", responsible: "", status: "" };
const subscriptionFilterFields: { key: SubscriptionFilterKey; label: string }[] = [
  { key: "pricing", label: "Pricing" }, { key: "company", label: "Company" },
  { key: "billing", label: "Billing cycle" }, { key: "status", label: "Status" },
  { key: "responsible", label: "Responsible person" }, { key: "nextReview", label: "Next review" },
];

type SubscriptionSort = {
  key: SubscriptionSortKey;
  direction: SortDirection;
};

type FilterOption = {
  value: string;
  label: string;
};

const billingCycleLabels: Record<SubscriptionBillingCycle, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  annual: "Annual",
  other: "Other",
};

function formatDate(value: string | null) {
  if (!value) return "Not recorded";
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatCurrency(amountCents: number | null) {
  if (amountCents === null) return "Free";
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
  }).format(amountCents / 100);
}

function compareSubscriptionText(left: string | null | undefined, right: string | null | undefined) {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return left.localeCompare(right, "en-AU", { numeric: true, sensitivity: "base" });
}

function monthlyCostLabel(subscription: Subscription) {
  if (subscription.pricingModel === "free") return "Free";
  const monthlyCents = subscriptionMonthlyEquivalentCents(subscription);
  return monthlyCents === null ? "—" : `${formatCurrency(monthlyCents)} / mo`;
}

function billingFilterValue(subscription: Subscription) {
  return subscription.pricingModel === "free" ? "free" : subscription.billingCycle ?? "other";
}

function hasQuarterlyReview(subscription?: Subscription) {
  return subscription?.pricingModel === "paid" && subscription.status !== "cancelled";
}

function passwordReviewInstruction(subscription?: Subscription) {
  if (!subscription || subscription.status === "cancelled") return null;
  const service = subscription.serviceName.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
  if (["aroflo", "aroflooffice", "ispring"].includes(service)) {
    return "Password review: prompt users to reset their password on next login.";
  }
  if (["xero", "deputy"].includes(service)) {
    return "Password review: confirm the management/accounts access list and rotate the credentials.";
  }
  if (service === "canva") {
    return "Password review: update the password and share it with the approved main users.";
  }
  return null;
}

function reviewFilterValue(subscription: Subscription) {
  if (!hasQuarterlyReview(subscription)) return "notScheduled";
  return subscriptionReviewWindow(subscription.nextReviewOn);
}

function reviewSortValue(subscription: Subscription) {
  return hasQuarterlyReview(subscription) ? subscription.nextReviewOn : "9999-12-31";
}

function subscriptionSearchText(subscription: Subscription) {
  return [
    subscription.serviceName,
    subscription.planName,
    subscription.subscriptionCode,
    subscriptionCompanyLabel(subscription.company),
    subscription.responsible.fullName,
    subscription.creditCardHolder,
    ...subscription.memberNames,
  ].filter(Boolean).join(" ").toLocaleLowerCase();
}

function isReviewDue(subscription: Subscription) {
  return hasQuarterlyReview(subscription) && subscriptionReviewWindow(subscription.nextReviewOn) === "due";
}

function amountToCents(value: string) {
  const cleaned = value.trim();
  if (!cleaned) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) return null;
  const cents = Math.round(Number(cleaned) * 100);
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
}

function centsToAmount(value: number | null) {
  return value === null ? "" : (value / 100).toFixed(2);
}

function SubscriptionSheetHeader({
  label,
  sortKey,
  activeSort,
  onSort,
  filterKey,
  filterOptions = [],
  filterValue = "",
  isFilterOpen = false,
  onToggleFilter,
  onFilter,
}: {
  label: string;
  sortKey?: SubscriptionSortKey;
  activeSort: SubscriptionSort | null;
  onSort?: (key: SubscriptionSortKey) => void;
  filterKey?: SubscriptionFilterKey;
  filterOptions?: FilterOption[];
  filterValue?: string;
  isFilterOpen?: boolean;
  onToggleFilter?: (key: SubscriptionFilterKey) => void;
  onFilter?: (key: SubscriptionFilterKey, value: string) => void;
}) {
  const sortIsActive = sortKey !== undefined && activeSort?.key === sortKey;
  const sortDirection = sortIsActive ? activeSort.direction : undefined;
  const filterIsActive = Boolean(filterValue);

  return <div className={styles.sheetHeaderCell} role="columnheader" aria-sort={sortKey ? (sortIsActive ? sortDirection : "none") : undefined} data-subscription-filter={filterKey}>
    <span>{label}</span>
    {(sortKey || filterKey) ? <span className={styles.sheetHeaderTools}>
      {sortKey && onSort ? <button
        type="button"
        className={styles.sheetHeaderButton}
        data-active={sortIsActive || undefined}
        onClick={() => onSort(sortKey)}
        aria-label={`Sort subscriptions by ${label}${sortDirection ? `, currently ${sortDirection}` : ""}`}
        aria-pressed={sortIsActive}
        title={`Sort by ${label}`}
      ><ArrowDownUp size={13} aria-hidden="true" /></button> : null}
      {filterKey && onToggleFilter ? <button
        type="button"
        className={styles.sheetHeaderButton}
        data-subscription-filter-trigger={filterKey}
        data-active={filterIsActive || undefined}
        onClick={() => onToggleFilter(filterKey)}
        aria-label={`Filter subscriptions by ${label}`}
        aria-expanded={isFilterOpen}
        title={`Filter by ${label}`}
      ><Filter size={13} aria-hidden="true" /></button> : null}
    </span> : null}
    {filterKey && onFilter && isFilterOpen ? <div className={styles.sheetFilterMenu} role="group" aria-label={`Filter subscriptions by ${label}`}>
      <button type="button" aria-pressed={!filterValue} onClick={() => onFilter(filterKey, "")}>All</button>
      {filterOptions.map((option) => <button key={option.value} type="button" aria-pressed={filterValue === option.value} onClick={() => onFilter(filterKey, option.value)}>{option.label}</button>)}
    </div> : null}
  </div>;
}

/** System Admin operational subscription register. Credential delegates use a smaller separate view. */
export function SubscriptionRegister({
  readOnly = false,
  canManageCredentials = false,
  canManageCredentialGrants = false,
  onRecordsChanged,
}: {
  readOnly?: boolean;
  /** Enables encrypted credential actions without expanding any data projection. */
  canManageCredentials?: boolean;
  /** System Admin-only capability to choose credential delegates. */
  canManageCredentialGrants?: boolean;
  /** Refreshes dependent calendar data after an owner, status or review changes. */
  onRecordsChanged?: () => void;
}) {
  const [registerState, setRegisterState] = useState<RegisterState>({ state: "loading" });
  const [people, setPeople] = useState<SubscriptionPerson[]>([]);
  const [query, setQuery] = useState("");
  const [subscriptionSort, setSubscriptionSort] = useState<SubscriptionSort | null>(null);
  const [activeSubscriptionFilter, setActiveSubscriptionFilter] = useState<SubscriptionFilterKey | null>(null);
  const [subscriptionFilters, setSubscriptionFilters] = useState<Record<SubscriptionFilterKey, string>>(emptySubscriptionFilters);
  const [showFilters, setShowFilters] = useState(false);
  const filterPanelId = useId();
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editTarget, setEditTarget] = useState<Subscription | null>(null);
  const [credentialTarget, setCredentialTarget] = useState<Subscription | null>(null);
  const [credentialStates, setCredentialStates] = useState<Record<string, boolean>>({});
  const [showCredentialAccess, setShowCredentialAccess] = useState(false);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkEdit, setShowBulkEdit] = useState(false);
  const bulkEditButtonRef = useRef<HTMLButtonElement>(null);
  const selectionFocusRef = useRef<HTMLDivElement>(null);
  const addSubscriptionButtonRef = useRef<HTMLButtonElement>(null);
  const subscriptionDialogReturnFocusRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async () => {
    setRegisterState({ state: "loading" });
    try {
      const [subscriptions, activePeople, credentialCatalogue] = await Promise.all([
        listSubscriptions(),
        readOnly ? Promise.resolve([]) : listSubscriptionPeople(),
        canManageCredentials
          ? listSubscriptionCredentialCatalogue()
          : Promise.resolve([]),
      ]);
      setRegisterState({ state: "ready", subscriptions });
      setSelectedIds((current) => new Set([...current].filter((id) => subscriptions.some((item) => item.id === id))));
      setPeople(activePeople);
      setCredentialStates(Object.fromEntries(credentialCatalogue.map((item) => [item.subscriptionId, item.credentialsSaved])));
    } catch (error) {
      setRegisterState({
        state: "error",
        message: error instanceof Error ? error.message : "Subscriptions could not be loaded.",
      });
    }
  }, [canManageCredentials, readOnly]);

  useEffect(() => {
    // Defer the initial server action until after this render commits. This
    // avoids synchronously moving the component from its loading state while
    // React is reconciling the parent People workspace.
    const loadTimer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(loadTimer);
  }, [load]);

  useEffect(() => {
    if (!activeSubscriptionFilter) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-subscription-filter]")) return;
      setActiveSubscriptionFilter(null);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      const filterKey = activeSubscriptionFilter;
      setActiveSubscriptionFilter(null);
      if (filterKey) window.requestAnimationFrame(() => {
        document.querySelector<HTMLButtonElement>(`[data-subscription-filter-trigger="${filterKey}"]`)?.focus();
      });
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [activeSubscriptionFilter]);

  const subscriptionFilterOptions = useMemo<Record<SubscriptionFilterKey, FilterOption[]>>(() => {
    const subscriptions = registerState.state === "ready" ? registerState.subscriptions : [];
    return {
      pricing: [{ value: "paid", label: "Paid" }, { value: "free", label: "Free" }],
      company: [
        { value: "mam", label: "MAM (including Both)" },
        { value: "equipsy", label: "Equipsy (including Both)" },
        { value: "both", label: "Both companies only" },
        { value: "unset", label: "Not set" },
      ],
      billing: [
        { value: "free", label: "Free" },
        ...SUBSCRIPTION_BILLING_CYCLES.filter((cycle) => subscriptions.some((subscription) => billingFilterValue(subscription) === cycle)).map((value) => ({ value, label: billingCycleLabels[value] })),
      ].filter((option) => subscriptions.some((subscription) => billingFilterValue(subscription) === option.value)),
      nextReview: [
        { value: "due", label: "Due now" },
        { value: "next30", label: "Next 30 days" },
        { value: "later", label: "Later" },
        { value: "notScheduled", label: "Not scheduled" },
      ].filter((option) => subscriptions.some((subscription) => reviewFilterValue(subscription) === option.value)),
      responsible: Array.from(new Map(subscriptions.map((subscription) => [subscription.responsible.personId, subscription.responsible.fullName])).entries())
        .sort(([, first], [, second]) => compareSubscriptionText(first, second))
        .map(([value, label]) => ({ value, label })),
      status: ["active", "paused", "cancelled"].filter((value) => subscriptions.some((subscription) => subscription.status === value)).map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) })),
    };
  }, [registerState]);

  const filteredSubscriptions = useMemo(() => {
    if (registerState.state !== "ready") return [];
    const term = query.trim().toLocaleLowerCase();
    const nextSubscriptions = registerState.subscriptions.filter((subscription) => {
      if (term && !subscriptionSearchText(subscription).includes(term)) return false;
      if (!matchesSubscriptionCategory(subscription, subscriptionFilters.pricing, subscriptionFilters.company)) return false;
      if (subscriptionFilters.billing && billingFilterValue(subscription) !== subscriptionFilters.billing) return false;
      if (subscriptionFilters.nextReview && reviewFilterValue(subscription) !== subscriptionFilters.nextReview) return false;
      if (subscriptionFilters.responsible && subscription.responsible.personId !== subscriptionFilters.responsible) return false;
      if (subscriptionFilters.status && subscription.status !== subscriptionFilters.status) return false;
      return true;
    });

    if (!subscriptionSort) return nextSubscriptions;
    const direction = subscriptionSort.direction === "ascending" ? 1 : -1;
    return [...nextSubscriptions].sort((first, second) => {
      let result = 0;
      switch (subscriptionSort.key) {
        case "service":
          result = compareSubscriptionText(first.serviceName, second.serviceName);
          break;
        case "monthly":
          return compareSubscriptionMonthlyCost(first, second, subscriptionSort.direction);
        case "seats":
          result = (first.seatCount ?? Number.MAX_SAFE_INTEGER) - (second.seatCount ?? Number.MAX_SAFE_INTEGER);
          break;
        case "nextBilling":
          result = compareSubscriptionText(first.nextBillingOn, second.nextBillingOn);
          break;
        case "lastReviewed":
          result = compareSubscriptionText(first.lastReviewedOn, second.lastReviewedOn);
          break;
        case "nextReview":
          result = compareSubscriptionText(reviewSortValue(first), reviewSortValue(second));
          break;
        case "responsible":
          result = compareSubscriptionText(first.responsible.fullName, second.responsible.fullName);
          break;
        case "status":
          result = compareSubscriptionText(first.status, second.status);
          break;
        case "members":
          result = first.memberNames.length - second.memberNames.length;
          break;
      }
      return result * direction;
    });
  }, [query, registerState, subscriptionFilters, subscriptionSort]);

  const hasSubscriptionFilters = Object.values(subscriptionFilters).some(Boolean);
  const selectedSubscriptions = registerState.state === "ready"
    ? registerState.subscriptions.filter((subscription) => selectedIds.has(subscription.id)) : [];
  const allShownSelected = filteredSubscriptions.length > 0 && filteredSubscriptions.every((subscription) => selectedIds.has(subscription.id));
  const someShownSelected = filteredSubscriptions.some((subscription) => selectedIds.has(subscription.id));

  function toggleSelected(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleShown() {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const subscription of filteredSubscriptions) {
        if (allShownSelected) next.delete(subscription.id); else next.add(subscription.id);
      }
      return next;
    });
  }

  async function bulkEditCompleted(result: SubscriptionBulkResult) {
    setSelectedIds(new Set(result.failures.map((failure) => failure.id)));
    if (result.updatedIds.length) onRecordsChanged?.();
    // Refresh optimistic versions, including uncertain network outcomes, before
    // a failed item can be retried. Preserve the results if refresh itself fails.
    try {
      const subscriptions = await listSubscriptions();
      setRegisterState({ state: "ready", subscriptions });
    } catch {
      setNotice("Refresh the register before retrying any remaining subscriptions.");
    }
  }

  function toggleSubscriptionSort(key: SubscriptionSortKey) {
    setSubscriptionSort((current) => current?.key === key
      ? { key, direction: current.direction === "ascending" ? "descending" : "ascending" }
      : { key, direction: "ascending" });
  }

  function setSubscriptionFilter(key: SubscriptionFilterKey, value: string) {
    setSubscriptionFilters((current) => ({ ...current, [key]: value }));
    const restoreColumnFocus = activeSubscriptionFilter === key;
    setActiveSubscriptionFilter(null);
    if (!restoreColumnFocus) return;
    window.requestAnimationFrame(() => {
      const trigger = document.querySelector<HTMLButtonElement>(`[data-subscription-filter-trigger="${key}"]`);
      // The phone picker owns focus while the desktop header is hidden.
      if (trigger?.getClientRects().length) trigger.focus({ preventScroll: true });
    });
  }

  function toggleSubscriptionFilter(key: SubscriptionFilterKey) {
    setActiveSubscriptionFilter((current) => current === key ? null : key);
  }

  function replaceSubscription(next: Subscription, message: string) {
    setRegisterState((current) => current.state !== "ready" ? current : {
      state: "ready",
      subscriptions: current.subscriptions.map((subscription) => subscription.id === next.id ? next : subscription),
    });
    setNotice(message);
    onRecordsChanged?.();
  }

  function subscriptionCreated(next: Subscription) {
    setRegisterState((current) => current.state !== "ready" ? {
      state: "ready",
      subscriptions: [next],
    } : {
      state: "ready",
      subscriptions: [...current.subscriptions, next].sort((first, second) => reviewSortValue(first).localeCompare(reviewSortValue(second))),
    });
    setShowAdd(false);
    setNotice(hasQuarterlyReview(next)
      ? `${next.serviceName} has been added. Its first quarterly review is ${formatDate(next.nextReviewOn)}.`
      : `${next.serviceName} has been added. Free subscriptions do not have a quarterly review schedule.`);
    onRecordsChanged?.();
  }

  async function recordReview(subscription: Subscription) {
    if (reviewingId) throw new Error("Another review is already being recorded.");
    setReviewingId(subscription.id);
    try {
      replaceSubscription(await markSubscriptionReviewed({
        subscriptionId: subscription.id,
        version: subscription.version,
      }), `Quarterly review recorded for ${subscription.serviceName}.`);
    } finally {
      setReviewingId(null);
    }
  }

  return <section className={styles.workspace} aria-label="Subscription management">
    <header className={toolbar.toolbar}>
      <div className={toolbar.controls} ref={selectionFocusRef} tabIndex={-1} aria-label="Subscription tools">
        <label className={toolbar.search}><Search size={17} aria-hidden="true" /><span className={styles.visuallyHidden}>Search subscriptions</span><input value={query} onChange={(event) => setQuery(event.target.value)} type="search" placeholder="Search service, owner or employee" /></label>
        {registerState.state === "ready" ? <div className={toolbar.summary}>
          {hasSubscriptionFilters ? <button className={toolbar.button} type="button" onClick={() => setSubscriptionFilters(emptySubscriptionFilters)}>Clear filters</button> : null}
          <button className={toolbar.button} type="button" ref={filterButtonRef} aria-expanded={showFilters} aria-controls={filterPanelId} onClick={() => setShowFilters((open) => !open)}>
            <Filter size={16} aria-hidden="true" /><span><strong>Filters{hasSubscriptionFilters ? ` · ${Object.values(subscriptionFilters).filter(Boolean).length}` : ""}</strong></span><ChevronDown size={16} aria-hidden="true" />
          </button>
        </div> : null}
      </div>
      <div className={toolbar.actions}>
        {canManageCredentialGrants ? <button className={toolbar.button} type="button" onClick={() => setShowCredentialAccess(true)} aria-label="Manage credential access" title="Credential access"><UsersRound size={16} aria-hidden="true" /></button> : null}
        {!readOnly ? <button className={toolbar.primary} type="button" onClick={() => { subscriptionDialogReturnFocusRef.current = addSubscriptionButtonRef.current; setShowAdd(true); }} ref={addSubscriptionButtonRef}><Plus size={16} /> Add</button> : <div className={styles.readOnlyBadge}><ShieldCheck size={15} /> Read only</div>}
      </div>
    </header>

    {notice ? <div className={styles.notice} role="status"><CheckCircle2 size={16} aria-hidden="true" /><span>{notice}</span><button type="button" onClick={() => setNotice("")} aria-label="Dismiss message"><X size={15} /></button></div> : null}

    {registerState.state === "ready" ? <section id={filterPanelId} className={styles.filterPanel} aria-label="Subscription filters" hidden={!showFilters} onKeyDown={(event) => {
      if (event.key === "Escape" && event.target instanceof HTMLElement && event.target.tagName !== "SELECT") {
        setShowFilters(false);
        filterButtonRef.current?.focus();
      }
    }}>
      <div className={styles.filterGrid}>{subscriptionFilterFields.map(({ key, label }) => <label key={key}><span>{label}</span><select value={subscriptionFilters[key]} onChange={(event) => setSubscriptionFilter(key, event.target.value)}><option value="">All</option>{subscriptionFilterOptions[key].map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>)}</div>
      <div className={styles.filterPanelFooter}><span aria-live="polite">{subscriptionCountLabel(filteredSubscriptions, registerState.subscriptions.length)}</span><button className={styles.secondaryAction} type="button" onClick={() => { setShowFilters(false); filterButtonRef.current?.focus(); }}>Done</button></div>
    </section> : null}

    {registerState.state === "loading" ? <div className={styles.loadingState}><LoaderCircle className={styles.spinner} size={22} aria-hidden="true" /><span>Loading subscriptions…</span></div> : null}
    {registerState.state === "error" ? <div className={styles.errorState} role="alert"><AlertCircle size={19} aria-hidden="true" /><div><strong>Subscriptions could not be loaded</strong><span>{registerState.message}</span></div><button className={styles.secondaryAction} type="button" onClick={() => void load()}><RefreshCw size={15} /> Retry</button></div> : null}
    {registerState.state === "ready" ? <MobileRegisterTools
      sort={subscriptionSort}
      onSort={setSubscriptionSort}
      sortOptions={[
        { value: "service", label: "Service" }, { value: "monthly", label: "Monthly cost" },
        { value: "seats", label: "Seats / licences" }, { value: "nextBilling", label: "Next billing" },
        { value: "lastReviewed", label: "Last reviewed" }, { value: "nextReview", label: "Next review" }, { value: "responsible", label: "Responsible" },
        { value: "status", label: "Status" }, { value: "members", label: "Access" },
      ]}
      filters={([
        { key: "billing", label: "Billing" }, { key: "nextReview", label: "Next review" },
        { key: "responsible", label: "Responsible" }, { key: "status", label: "Status" },
      ] as const).map(filter => ({ ...filter, value: subscriptionFilters[filter.key], options: subscriptionFilterOptions[filter.key] }))}
      onFilter={setSubscriptionFilter}
    /> : null}
    {registerState.state === "ready" && !readOnly ? <div className={`${styles.bulkToolbar} ${!selectedSubscriptions.length ? styles.emptySelection : ""}`} aria-label="Subscription selection">
      <label className={`${styles.selectionLabel} ${styles.mobileSelectAll}`}><input type="checkbox" checked={allShownSelected} disabled={!filteredSubscriptions.length} ref={(node) => { if (node) node.indeterminate = someShownSelected && !allShownSelected; }} onChange={toggleShown} />Select all shown</label>
      <span aria-live="polite">{selectedSubscriptions.length ? `${selectedSubscriptions.length} selected` : ""}</span>
      {selectedSubscriptions.length ? <><button className={styles.secondaryAction} type="button" onClick={() => setSelectedIds(new Set())}>Clear selection</button><button ref={bulkEditButtonRef} className={styles.primaryAction} type="button" onClick={() => setShowBulkEdit(true)}><Pencil size={15} aria-hidden="true" />Edit selected</button></> : null}
    </div> : null}
    {registerState.state === "ready" && !filteredSubscriptions.length ? <div className={styles.emptyState}><CreditCard size={25} aria-hidden="true" /><strong>{query || hasSubscriptionFilters ? "No subscriptions match those filters" : "No subscriptions have been added"}</strong><span>{readOnly ? "Subscription records will appear here when they are created by a System Admin." : "Start with the systems your staff use, then assign their owner and access."}</span>{!readOnly && !query && !hasSubscriptionFilters ? <button className={styles.secondaryAction} type="button" onClick={() => { subscriptionDialogReturnFocusRef.current = addSubscriptionButtonRef.current; setShowAdd(true); }}><Plus size={15} /> Add subscription</button> : null}</div> : null}
    {registerState.state === "ready" && filteredSubscriptions.length ? <div className={styles.sheetViewport}>
      <div className={`${styles.subscriptionSheet} ${!readOnly ? styles.selectableSheet : ""}`} role="table" aria-label="Subscriptions">
        <div className={`${styles.subscriptionSheetRow} ${styles.subscriptionSheetHeader}`} role="row">
          {!readOnly ? <div className={`${styles.sheetHeaderCell} ${styles.selectionCell}`} role="columnheader"><label className={styles.selectionLabel}><input type="checkbox" checked={allShownSelected} ref={(node) => { if (node) node.indeterminate = someShownSelected && !allShownSelected; }} onChange={toggleShown} aria-label="Select all shown subscriptions" /><span>Select</span></label></div> : null}
          <SubscriptionSheetHeader label="Service" sortKey="service" activeSort={subscriptionSort} onSort={toggleSubscriptionSort} />
          <SubscriptionSheetHeader label="Monthly" sortKey="monthly" activeSort={subscriptionSort} onSort={toggleSubscriptionSort} filterKey="billing" filterOptions={subscriptionFilterOptions.billing} filterValue={subscriptionFilters.billing} isFilterOpen={activeSubscriptionFilter === "billing"} onToggleFilter={toggleSubscriptionFilter} onFilter={setSubscriptionFilter} />
          <SubscriptionSheetHeader label="Seats / licences" sortKey="seats" activeSort={subscriptionSort} onSort={toggleSubscriptionSort} />
          <SubscriptionSheetHeader label="Next billing" sortKey="nextBilling" activeSort={subscriptionSort} onSort={toggleSubscriptionSort} />
          <SubscriptionSheetHeader label="Last reviewed" sortKey="lastReviewed" activeSort={subscriptionSort} onSort={toggleSubscriptionSort} />
          <SubscriptionSheetHeader label="Next review" sortKey="nextReview" activeSort={subscriptionSort} onSort={toggleSubscriptionSort} filterKey="nextReview" filterOptions={subscriptionFilterOptions.nextReview} filterValue={subscriptionFilters.nextReview} isFilterOpen={activeSubscriptionFilter === "nextReview"} onToggleFilter={toggleSubscriptionFilter} onFilter={setSubscriptionFilter} />
          <SubscriptionSheetHeader label="Responsible" sortKey="responsible" activeSort={subscriptionSort} onSort={toggleSubscriptionSort} filterKey="responsible" filterOptions={subscriptionFilterOptions.responsible} filterValue={subscriptionFilters.responsible} isFilterOpen={activeSubscriptionFilter === "responsible"} onToggleFilter={toggleSubscriptionFilter} onFilter={setSubscriptionFilter} />
          <SubscriptionSheetHeader label="Status" sortKey="status" activeSort={subscriptionSort} onSort={toggleSubscriptionSort} filterKey="status" filterOptions={subscriptionFilterOptions.status} filterValue={subscriptionFilters.status} isFilterOpen={activeSubscriptionFilter === "status"} onToggleFilter={toggleSubscriptionFilter} onFilter={setSubscriptionFilter} />
          <SubscriptionSheetHeader label="Access" sortKey="members" activeSort={subscriptionSort} onSort={toggleSubscriptionSort} />
          <div className={styles.sheetHeaderCell} role="columnheader"><span>Actions</span></div>
        </div>
        {filteredSubscriptions.map((subscription) => <div className={styles.subscriptionSheetRow} key={subscription.id} role="row" data-selected={selectedIds.has(subscription.id) || undefined}>
          {!readOnly ? <div className={`${styles.sheetCell} ${styles.selectionCell}`} role="cell"><label className={styles.selectionLabel}><input type="checkbox" checked={selectedIds.has(subscription.id)} onChange={() => toggleSelected(subscription.id)} aria-label={`Select ${subscription.serviceName}`} /><span className={styles.mobileSelectionText}>Select</span></label></div> : null}
          <div className={`${styles.sheetCell} ${styles.serviceCell}`} role="cell" data-label="Service">
            <div className={styles.subscriptionIcon}><CreditCard size={18} aria-hidden="true" /></div>
            <div className={styles.subscriptionIdentity}><strong>{subscription.serviceName}</strong><span className={styles.companyBadge} data-company={subscription.company ?? "unset"} aria-label={`Company: ${subscriptionCompanyLabel(subscription.company)}`}>{subscriptionCompanyLabel(subscription.company)}</span>{subscription.planName ? <span title={subscription.planName}>{subscription.planName}</span> : null}</div>
          </div>
          <div className={`${styles.sheetCell} ${styles.monthlyCell}`} role="cell" data-label="Monthly"><strong>{monthlyCostLabel(subscription)}</strong></div>
          <div className={`${styles.sheetCell} ${styles.detailCell} ${styles.seatCell}`} role="cell" data-label="Seats / licences"><strong>{subscription.pricingModel === "paid" ? subscription.seatCount ?? "Not recorded" : "—"}</strong></div>
          <div className={`${styles.sheetCell} ${styles.detailCell} ${styles.billingCell}`} role="cell" data-label="Next billing">
            <strong>{subscription.pricingModel === "paid" ? (subscription.nextBillingOn ? formatDate(subscription.nextBillingOn) : subscription.billingCycle === "other" ? "Manual schedule" : "Not recorded") : "—"}</strong>
            {subscription.pricingModel === "paid" ? <><small>Billing date: {formatDate(subscription.billingDate)}</small><small>Credit card: {subscription.creditCardUsed === null ? "Not recorded" : subscription.creditCardUsed ? "Yes" : "No"}</small>{subscription.creditCardUsed ? <small>Cardholder: {subscription.creditCardHolder ?? "Not recorded"}</small> : null}</> : null}
          </div>
          <div className={`${styles.sheetCell} ${styles.detailCell} ${styles.lastReviewedCell}`} role="cell" data-label="Last reviewed"><strong>{hasQuarterlyReview(subscription) ? (subscription.lastReviewedOn ? formatDate(subscription.lastReviewedOn) : "Not yet reviewed") : "—"}</strong></div>
          <div className={`${styles.sheetCell} ${styles.reviewCell}`} role="cell" data-label="Next review" data-due={isReviewDue(subscription)}><strong>{hasQuarterlyReview(subscription) ? formatDate(subscription.nextReviewOn) : <><span aria-hidden="true">—</span><span className={styles.visuallyHidden}>No quarterly review scheduled</span></>}</strong></div>
          <div className={`${styles.sheetCell} ${styles.responsibleCell}`} role="cell" data-label="Responsible"><strong>{subscription.responsible.fullName}</strong></div>
          <div className={`${styles.sheetCell} ${styles.statusCell}`} role="cell" data-label="Status"><span data-status={subscription.status}>{subscription.status}</span></div>
          <div className={`${styles.sheetCell} ${styles.membersCell}`} role="cell" data-label="Access"><strong title={`${subscription.memberNames.length} ${subscription.memberNames.length === 1 ? "person" : "people"} assigned`}>{subscription.memberNames.length || "—"}</strong></div>
          <div className={`${styles.sheetCell} ${styles.subscriptionActions}`} role="cell" data-label="Actions">
            {canManageCredentials ? <button type="button" onClick={() => setCredentialTarget(subscription)} disabled={reviewingId !== null}><KeyRound size={15} /> Credentials</button> : null}
            {!readOnly ? <button type="button" onClick={(event) => { subscriptionDialogReturnFocusRef.current = event.currentTarget; setEditTarget(subscription); }} disabled={reviewingId !== null}><Pencil size={15} /> Edit</button> : null}
            {!canManageCredentials && readOnly ? <span className={styles.readOnlyCell} aria-label="Read only">—</span> : null}
          </div>
        </div>)}
      </div>
    </div> : null}

    {showBulkEdit && !readOnly ? <SubscriptionBulkModal subscriptions={selectedSubscriptions} people={people} fallbackFocusRef={selectionFocusRef} onClose={() => setShowBulkEdit(false)} onCompleted={bulkEditCompleted} /> : null}
    {showAdd ? <SubscriptionModal people={people} fallbackFocusRef={subscriptionDialogReturnFocusRef} onClose={() => setShowAdd(false)} onCreated={subscriptionCreated} /> : null}
    {editTarget ? <SubscriptionModal people={people} subscription={editTarget} fallbackFocusRef={subscriptionDialogReturnFocusRef} onClose={() => setEditTarget(null)} onUpdated={(next) => { replaceSubscription(next, `${next.serviceName} has been updated.`); setEditTarget(null); }} onReview={() => recordReview(editTarget)} /> : null}
    {credentialTarget ? <SubscriptionCredentialEditor
      subscriptionId={credentialTarget.id}
      serviceName={credentialTarget.serviceName}
      planName={credentialTarget.planName ?? ""}
      credentialsSaved={credentialStates[credentialTarget.id] === true}
      onClose={() => setCredentialTarget(null)}
      onSaved={() => setCredentialStates((current) => ({ ...current, [credentialTarget.id]: true }))}
      onRemoved={() => setCredentialStates((current) => ({ ...current, [credentialTarget.id]: false }))}
    /> : null}
    {showCredentialAccess ? <SubscriptionCredentialAccessDialog onClose={() => setShowCredentialAccess(false)} /> : null}
  </section>;
}

function SubscriptionBulkModal({ subscriptions, people, fallbackFocusRef, onClose, onCompleted }: {
  subscriptions: Subscription[];
  people: SubscriptionPerson[];
  fallbackFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onCompleted: (result: SubscriptionBulkResult) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const [company, setCompany] = useState<"" | SubscriptionCompany>("");
  const [status, setStatus] = useState<"" | Subscription["status"]>("");
  const [responsiblePersonId, setResponsiblePersonId] = useState("");
  const [saving, setSaving] = useState(false);
  const [completed, setCompleted] = useState(0);
  const [result, setResult] = useState<SubscriptionBulkResult | null>(null);
  const [error, setError] = useState("");
  const closeWhenReady = useCallback(() => { if (!saving) onClose(); }, [onClose, saving]);
  useDialogFocus(true, dialogRef, null, closeWhenReady, fallbackFocusRef);
  const hasChanges = Boolean(company || status || responsiblePersonId);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !hasChanges) return;
    setError("");
    setSaving(true);
    setCompleted(0);
    const patch: SubscriptionBulkPatch = {
      ...(company ? { company } : {}),
      ...(status ? { status } : {}),
      ...(responsiblePersonId ? { responsiblePersonId } : {}),
    };
    try {
      const outcome = await runSubscriptionBulkEdit(subscriptions, patch,
        (target, selectedPatch) => patchSubscription({ id: target.id, version: target.version, patch: selectedPatch }), setCompleted);
      setResult(outcome);
      await onCompleted(outcome);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Subscriptions could not be updated.");
    } finally {
      setSaving(false);
    }
  }

  return <ModalBackdrop className={styles.modalBackdrop} onPointerDown={(event) => { if (event.target === event.currentTarget) closeWhenReady(); }}>
    <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="subscription-bulk-title" ref={dialogRef} aria-busy={saving}>
      <header><div><h2 id="subscription-bulk-title">Edit subscriptions</h2></div><button type="button" onClick={closeWhenReady} disabled={saving} aria-label="Close bulk edit"><X size={20} /></button></header>
      <form onSubmit={submit}>
        {result ? <div className={styles.bulkResult} role="status"><strong>{result.updatedIds.length} updated{result.failures.length ? ` · ${result.failures.length} need attention` : ""}</strong>
          {result.failures.length ? <ul>{result.failures.map((failure) => <li key={failure.id}><strong>{failure.serviceName}</strong><span>{failure.message}</span></li>)}</ul> : null}
        </div> : <>
          <details className={styles.bulkSummary}><summary>{subscriptions.length} selected</summary><ul>{subscriptions.map((subscription) => <li key={subscription.id}>{subscription.serviceName}</li>)}</ul></details>
          <div className={styles.formGrid}>
            <label><span>Company</span><select value={company} disabled={saving} onChange={(event) => setCompany(event.target.value as "" | SubscriptionCompany)}><option value="">Keep current</option>{SUBSCRIPTION_COMPANIES.map((value) => <option key={value} value={value}>{subscriptionCompanyLabel(value)}</option>)}</select></label>
            <label><span>Status</span><select value={status} disabled={saving} onChange={(event) => setStatus(event.target.value as "" | Subscription["status"])}><option value="">Keep current</option><option value="active">Active</option><option value="paused">Paused</option><option value="cancelled">Cancelled</option></select></label>
            <label><span>Responsible person</span><select value={responsiblePersonId} disabled={saving} onChange={(event) => setResponsiblePersonId(event.target.value)}><option value="">Keep current</option>{people.map((person) => <option key={person.personId} value={person.personId}>{person.fullName}</option>)}</select></label>
          </div>
        </>}
        {error ? <p className={styles.inlineError} role="alert"><AlertCircle size={16} />{error}</p> : null}
        <footer>{result ? <button type="button" className={styles.primaryAction} onClick={closeWhenReady} disabled={saving}>Done</button> : <><button type="button" className={styles.secondaryAction} onClick={closeWhenReady} disabled={saving}>Cancel</button><button type="submit" className={styles.primaryAction} disabled={saving || !hasChanges}>{saving ? `Saving ${completed} / ${subscriptions.length}…` : `Save ${subscriptions.length} subscriptions`}</button></>}</footer>
      </form>
    </section>
  </ModalBackdrop>;
}

function SubscriptionModal({
  people,
  subscription,
  fallbackFocusRef = null,
  onClose,
  onCreated,
  onUpdated,
  onReview,
}: {
  people: SubscriptionPerson[];
  subscription?: Subscription;
  fallbackFocusRef?: RefObject<HTMLElement | null> | null;
  onClose: () => void;
  onCreated?: (subscription: Subscription) => void;
  onUpdated?: (subscription: Subscription) => void;
  onReview?: () => Promise<void>;
}) {
  const isEditing = Boolean(subscription);
  const dialogRef = useRef<HTMLElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const initialSnapshotRef = useRef<string | null>(null);
  const initialFocusRef = useRef<HTMLInputElement>(null);
  const [pricingModel, setPricingModel] = useState<SubscriptionPricingModel>(subscription?.pricingModel ?? "free");
  const [creditCardUsed, setCreditCardUsed] = useState(subscription?.creditCardUsed === true ? "yes" : subscription?.creditCardUsed === false ? "no" : "");
  const [memberPersonIds, setMemberPersonIds] = useState<string[]>(subscription?.memberPersonIds ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const closeWhenReady = useCallback(() => { if (!saving) onClose(); }, [onClose, saving]);
  const passwordReminder = passwordReviewInstruction(subscription);
  const unavailableMemberIds = unavailableSubscriptionMemberIds(people, memberPersonIds);
  useDialogFocus(true, dialogRef, initialFocusRef, closeWhenReady, fallbackFocusRef);

  useEffect(() => {
    if (formRef.current) {
      initialSnapshotRef.current = subscriptionEditorSnapshot(new FormData(formRef.current), subscription?.memberPersonIds ?? []);
    }
  }, [subscription]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    if (unavailableMemberIds.length) {
      setError("Remove inactive or unavailable members under Employee access before saving.");
      return;
    }
    const form = new FormData(event.currentTarget);
    const amountText = String(form.get("amount") ?? "");
    const amountCents = pricingModel === "paid" ? amountToCents(amountText) : null;
    const seatCount = pricingModel === "paid" ? Number(form.get("seatCount")) : null;
    const cardChoice = pricingModel === "paid" ? String(form.get("creditCardUsed") ?? "") : "";
    const creditCardHolder = pricingModel === "paid" && cardChoice === "yes" ? String(form.get("creditCardHolder") ?? "").trim() : "";
    const billingDate = pricingModel === "paid" ? String(form.get("billingDate") ?? "") : "";
    if (pricingModel === "paid" && (amountCents === null || !Number.isSafeInteger(seatCount) || (seatCount ?? 0) < 1 || !["yes", "no"].includes(cardChoice) || (cardChoice === "yes" && !creditCardHolder) || !billingDate)) {
      setError("Enter the amount, seats or licences, credit-card details and billing date for this paid subscription.");
      return;
    }
    const baseInput: CreateSubscriptionInput = {
      company: String(form.get("company") ?? "") as SubscriptionCompany,
      serviceName: String(form.get("serviceName") ?? ""),
      planName: String(form.get("planName") ?? ""),
      pricingModel,
      billingCycle: pricingModel === "paid" ? String(form.get("billingCycle") ?? "") as SubscriptionBillingCycle : undefined,
      amountCents,
      renewalDate: String(form.get("renewalDate") ?? "") || null,
      seatCount,
      creditCardUsed: pricingModel === "paid" ? cardChoice === "yes" : null,
      creditCardHolder: creditCardHolder || null,
      billingDate: billingDate || null,
      responsiblePersonId: String(form.get("responsiblePersonId") ?? ""),
      memberPersonIds,
    };
    setSaving(true);
    setError("");
    try {
      if (subscription) {
        const status = String(form.get("status") ?? "") as UpdateSubscriptionInput["status"];
        onUpdated?.(await updateSubscription({ ...baseInput, subscriptionId: subscription.id, version: subscription.version, status }));
      } else {
        onCreated?.(await createSubscription(baseInput));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The subscription could not be saved. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function reviewNow() {
    if (!onReview || saving) return;
    if (!formRef.current || initialSnapshotRef.current !== subscriptionEditorSnapshot(new FormData(formRef.current), memberPersonIds)) {
      setError("Save your changes before marking this review complete. Your edits are still here.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onReview();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The review could not be recorded. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return <ModalBackdrop className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeWhenReady()}>
    <section className={styles.modal} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="subscription-dialog-title" tabIndex={-1}>
      <header><div><h2 id="subscription-dialog-title">{isEditing ? "Edit subscription" : "Add subscription"}</h2>{isEditing && subscription ? <p>{subscription.subscriptionCode}</p> : null}</div><button type="button" onClick={closeWhenReady} disabled={saving} aria-label="Close subscription form"><X size={19} /></button></header>
      <form ref={formRef} onSubmit={submit}>
        <fieldset className={styles.editorFields} disabled={saving}>
        <div className={styles.formGrid}>
          <label><span>Service name <b aria-hidden="true">*</b></span><input name="serviceName" ref={initialFocusRef} required maxLength={160} defaultValue={subscription?.serviceName ?? ""} placeholder="Microsoft 365, Adobe Creative Cloud…" /></label>
          <label><span>Plan <small>Optional</small></span><input name="planName" maxLength={160} defaultValue={subscription?.planName ?? ""} placeholder="Business Standard, Teams…" /></label>
          <label><span>Company <b aria-hidden="true">*</b></span><select name="company" required defaultValue={subscription?.company ?? ""}><option value="" disabled>Select company</option>{SUBSCRIPTION_COMPANIES.map((company) => <option value={company} key={company}>{subscriptionCompanyLabel(company)}</option>)}</select></label>
        </div>
        {isEditing ? <label><span>Status <b aria-hidden="true">*</b></span><select name="status" defaultValue={subscription?.status ?? "active"}><option value="active">Active</option><option value="paused">Paused</option><option value="cancelled">Cancelled</option></select></label> : null}
        <fieldset className={styles.pricingFieldset}>
          <legend>Pricing</legend>
          <div className={styles.pricingChoices}>
            <label><input type="radio" name="pricingModel" value="free" checked={pricingModel === "free"} onChange={() => setPricingModel("free")} /> Free</label>
            <label><input type="radio" name="pricingModel" value="paid" checked={pricingModel === "paid"} onChange={() => setPricingModel("paid")} /> Paid</label>
          </div>
          {pricingModel === "paid" ? <>
            <div className={styles.formGrid}>
              <label><span>Billing cycle <b aria-hidden="true">*</b></span><select name="billingCycle" required defaultValue={subscription?.billingCycle ?? "monthly"}>{SUBSCRIPTION_BILLING_CYCLES.map((cycle) => <option key={cycle} value={cycle}>{billingCycleLabels[cycle]}</option>)}</select></label>
              <label><span>Amount (AUD) <b aria-hidden="true">*</b></span><input name="amount" inputMode="decimal" required defaultValue={centsToAmount(subscription?.amountCents ?? null)} placeholder="0.00" /></label>
              <label><span>Seats / licences <b aria-hidden="true">*</b></span><input name="seatCount" type="number" min="1" max="100000" step="1" required defaultValue={subscription?.seatCount ?? ""} placeholder="1" /></label>
              <label><span>Credit card used <b aria-hidden="true">*</b></span><select name="creditCardUsed" required value={creditCardUsed} onChange={(event) => setCreditCardUsed(event.target.value)}><option value="" disabled>Choose</option><option value="yes">Yes</option><option value="no">No</option></select></label>
              {creditCardUsed === "yes" ? <label><span>Cardholder / card name <b aria-hidden="true">*</b></span><input name="creditCardHolder" required maxLength={160} defaultValue={subscription?.creditCardHolder ?? ""} placeholder="Gerard, Luke, Equipsy corporate card…" /></label> : null}
              <label><span>Billing date <b aria-hidden="true">*</b></span><input name="billingDate" type="date" required defaultValue={subscription?.billingDate ?? ""} /></label>
            </div>
            <p className={styles.formHelp}><CalendarClock size={15} /> Use a known charge date. Monthly, quarterly and annual next billing dates are calculated automatically.</p>
          </> : null}
        </fieldset>
        <div className={styles.formGrid}>
          <label><span>Renewal date <small>Optional</small></span><input name="renewalDate" type="date" defaultValue={subscription?.renewalDate ?? ""} /></label>
          <label><span>Responsible person <b aria-hidden="true">*</b></span><EmployeePicker assignees={people} defaultValue={subscription?.responsible.personId ?? ""} name="responsiblePersonId" disabled={!people.length} /></label>
        </div>
        {unavailableMemberIds.length ? <p className={styles.inlineError} role="status">{unavailableMemberIds.length} selected {unavailableMemberIds.length === 1 ? "member is" : "members are"} inactive or unavailable. Open Employee access to remove them before saving.</p> : null}
        <details className={styles.accessDetails}><summary>Employee access{memberPersonIds.length ? ` · ${memberPersonIds.length}` : ""}</summary><SubscriptionMemberPicker people={people} selectedIds={memberPersonIds} onChange={setMemberPersonIds} /></details>

        {isEditing && passwordReminder ? <p className={styles.formHelp}><KeyRound size={15} /> {passwordReminder} </p> : null}
        </fieldset>
        {error ? <p className={styles.inlineError} role="alert"><AlertCircle size={15} />{error}</p> : null}
        <footer><button className={styles.secondaryAction} type="button" onClick={closeWhenReady} disabled={saving}>Cancel</button>{isEditing && onReview && subscription && hasQuarterlyReview(subscription) ? <button className={styles.secondaryAction} type="button" onClick={() => void reviewNow()} disabled={saving}>{saving ? <LoaderCircle className={styles.spinner} size={16} /> : <CalendarClock size={16} />}{saving ? "Saving…" : "Mark review complete"}</button> : null}<button className={styles.primaryAction} type="submit" disabled={saving || !people.length}>{saving ? <LoaderCircle className={styles.spinner} size={16} /> : <CreditCard size={16} />}{saving ? "Saving…" : isEditing ? "Save changes" : "Add subscription"}</button></footer>
      </form>
    </section>
  </ModalBackdrop>;
}

function SubscriptionMemberPicker({
  people,
  selectedIds,
  onChange,
}: {
  people: SubscriptionPerson[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const listId = useId();
  const selected = new Set(selectedIds);
  const unavailableMemberIds = unavailableSubscriptionMemberIds(people, selectedIds);
  const filteredPeople = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return people.filter((person) => !term || [person.fullName, person.positionTitle, person.teamName, person.company].join(" ").toLocaleLowerCase().includes(term));
  }, [people, query]);

  function toggle(personId: string) {
    if (selected.has(personId)) onChange(selectedIds.filter((id) => id !== personId));
    else if (people.some((person) => person.personId === personId)) onChange([...selectedIds, personId]);
  }

  return <fieldset className={styles.membersFieldset}><legend>Who can view this subscription</legend>
    {unavailableMemberIds.length ? <div className={styles.unavailableMembers}>
      <p>These selected members are no longer available for assignment. Remove them before saving.</p>
      {unavailableMemberIds.map((personId, index) => <div className={styles.unavailableMember} key={personId}>
        <span>Inactive or unavailable member {index + 1}</span>
        <button type="button" className={styles.secondaryAction} onClick={() => toggle(personId)} aria-label={`Remove inactive or unavailable member ${index + 1}`}>Remove</button>
      </div>)}
    </div> : null}
    <label className={styles.memberSearch}><Search size={15} aria-hidden="true" /><span className={styles.visuallyHidden}>Search employees for subscription access</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search employees" type="search" /></label><div className={styles.memberSummary}>{selectedIds.length} selected</div><div className={styles.memberList} id={listId}>{filteredPeople.length ? filteredPeople.map((person) => <label className={styles.memberOption} key={person.personId}><input checked={selected.has(person.personId)} onChange={() => toggle(person.personId)} type="checkbox" /><span><strong>{person.fullName}</strong><small>{[person.positionTitle, person.teamName].filter(Boolean).join(" · ")}</small></span></label>) : <p className={styles.memberEmpty}>No employees match that search.</p>}</div></fieldset>;
}
