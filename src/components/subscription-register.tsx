"use client";

import {
  AlertCircle,
  ArrowDownUp,
  CalendarClock,
  CheckCircle2,
  CircleDollarSign,
  CreditCard,
  Filter,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  type FormEvent,
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
import { EmployeePicker } from "@/components/employee-picker";
import { useDialogFocus } from "@/components/ui/use-dialog-focus";
import styles from "@/components/subscription-register.module.css";
import {
  SUBSCRIPTION_BILLING_CYCLES,
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
type SubscriptionSortKey = "service" | "monthly" | "nextReview" | "responsible" | "status" | "members";
type SubscriptionFilterKey = "billing" | "nextReview" | "responsible" | "status";

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

function monthlyEquivalentCents(subscription: Subscription) {
  if (subscription.pricingModel !== "paid" || subscription.amountCents === null) return null;
  if (subscription.billingCycle === "monthly") return subscription.amountCents;
  if (subscription.billingCycle === "quarterly") return Math.round(subscription.amountCents / 3);
  if (subscription.billingCycle === "annual") return Math.round(subscription.amountCents / 12);
  return null;
}

function monthlyCostLabel(subscription: Subscription) {
  if (subscription.pricingModel === "free") return "Free";
  const monthlyCents = monthlyEquivalentCents(subscription);
  return monthlyCents === null ? "—" : `${formatCurrency(monthlyCents)} / mo`;
}

function billingFilterValue(subscription: Subscription) {
  return subscription.pricingModel === "free" ? "free" : subscription.billingCycle ?? "other";
}

function hasQuarterlyReview(subscription?: Subscription) {
  return subscription?.pricingModel === "paid" && subscription.status !== "cancelled";
}

function reviewFilterValue(subscription: Subscription) {
  if (!hasQuarterlyReview(subscription)) return "notScheduled";
  if (isReviewDue(subscription)) return "due";
  const inThirtyDays = new Date();
  inThirtyDays.setDate(inThirtyDays.getDate() + 30);
  return subscription.nextReviewOn <= inThirtyDays.toISOString().slice(0, 10) ? "next30" : "later";
}

function reviewSortValue(subscription: Subscription) {
  return hasQuarterlyReview(subscription) ? subscription.nextReviewOn : "9999-12-31";
}

function quarterlyReviewHint(subscription?: Subscription) {
  return hasQuarterlyReview(subscription)
    ? "Paid subscription reviews appear on the responsible person’s calendar."
    : "Free and cancelled subscriptions do not have a quarterly review scheduled.";
}

function subscriptionSearchText(subscription: Subscription) {
  return [
    subscription.serviceName,
    subscription.planName,
    subscription.subscriptionCode,
    subscription.responsible.fullName,
    ...subscription.memberNames,
  ].filter(Boolean).join(" ").toLocaleLowerCase();
}

function isReviewDue(subscription: Subscription) {
  return hasQuarterlyReview(subscription) && subscription.nextReviewOn <= new Date().toISOString().slice(0, 10);
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

  return <div className={styles.sheetHeaderCell} role="columnheader" aria-sort={sortKey ? (sortIsActive ? sortDirection : "none") : undefined} data-subscription-filter={filterKey ? "true" : undefined}>
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
        data-active={filterIsActive || undefined}
        onClick={() => onToggleFilter(filterKey)}
        aria-label={`Filter subscriptions by ${label}`}
        aria-expanded={isFilterOpen}
        aria-haspopup="menu"
        title={`Filter by ${label}`}
      ><Filter size={13} aria-hidden="true" /></button> : null}
    </span> : null}
    {filterKey && onFilter && isFilterOpen ? <div className={styles.sheetFilterMenu} role="menu" aria-label={`Filter subscriptions by ${label}`}>
      <button type="button" role="menuitemradio" aria-checked={!filterValue} onClick={() => onFilter(filterKey, "")}>All</button>
      {filterOptions.map((option) => <button key={option.value} type="button" role="menuitemradio" aria-checked={filterValue === option.value} onClick={() => onFilter(filterKey, option.value)}>{option.label}</button>)}
    </div> : null}
  </div>;
}

/** System Admin can manage; managers receive this exact register read-only. */
export function SubscriptionRegister({
  readOnly = false,
  onRecordsChanged,
}: {
  readOnly?: boolean;
  /** Refreshes dependent calendar data after an owner, status or review changes. */
  onRecordsChanged?: () => void;
}) {
  const [registerState, setRegisterState] = useState<RegisterState>({ state: "loading" });
  const [people, setPeople] = useState<SubscriptionPerson[]>([]);
  const [query, setQuery] = useState("");
  const [subscriptionSort, setSubscriptionSort] = useState<SubscriptionSort | null>(null);
  const [activeSubscriptionFilter, setActiveSubscriptionFilter] = useState<SubscriptionFilterKey | null>(null);
  const [subscriptionFilters, setSubscriptionFilters] = useState<Record<SubscriptionFilterKey, string>>({
    billing: "",
    nextReview: "",
    responsible: "",
    status: "",
  });
  const [showAdd, setShowAdd] = useState(false);
  const [editTarget, setEditTarget] = useState<Subscription | null>(null);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setRegisterState({ state: "loading" });
    try {
      const [subscriptions, activePeople] = await Promise.all([
        listSubscriptions(),
        readOnly ? Promise.resolve([]) : listSubscriptionPeople(),
      ]);
      setRegisterState({ state: "ready", subscriptions });
      setPeople(activePeople);
    } catch (error) {
      setRegisterState({
        state: "error",
        message: error instanceof Error ? error.message : "Subscriptions could not be loaded.",
      });
    }
  }, [readOnly]);

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
      if (event.key === "Escape") setActiveSubscriptionFilter(null);
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
          result = compareSubscriptionText(
            monthlyEquivalentCents(first) === null ? null : String(monthlyEquivalentCents(first)).padStart(18, "0"),
            monthlyEquivalentCents(second) === null ? null : String(monthlyEquivalentCents(second)).padStart(18, "0"),
          );
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

  function toggleSubscriptionSort(key: SubscriptionSortKey) {
    setSubscriptionSort((current) => current?.key === key
      ? { key, direction: current.direction === "ascending" ? "descending" : "ascending" }
      : { key, direction: "ascending" });
  }

  function setSubscriptionFilter(key: SubscriptionFilterKey, value: string) {
    setSubscriptionFilters((current) => ({ ...current, [key]: value }));
    setActiveSubscriptionFilter(null);
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
    <header className={styles.header}>
      <div><span>Access register</span><h2>Subscriptions</h2><p>Track subscription ownership, access and quarterly review dates in one place.</p></div>
      {!readOnly ? <button className={styles.primaryAction} type="button" onClick={() => setShowAdd(true)}><Plus size={16} /> Add subscription</button> : <div className={styles.readOnlyBadge}><ShieldCheck size={15} /> Management view</div>}
    </header>

    <div className={styles.securityNote}><ShieldCheck size={16} aria-hidden="true" /><span>Passwords, recovery codes and device passcodes are managed in the approved password manager—not stored here.</span></div>
    {notice ? <div className={styles.notice} role="status"><CheckCircle2 size={16} aria-hidden="true" /><span>{notice}</span><button type="button" onClick={() => setNotice("")} aria-label="Dismiss message"><X size={15} /></button></div> : null}

    <div className={styles.tools}>
      <label className={styles.searchField}><Search size={17} aria-hidden="true" /><span className={styles.visuallyHidden}>Search subscriptions</span><input value={query} onChange={(event) => setQuery(event.target.value)} type="search" placeholder="Search service, owner or employee" /></label>
      {registerState.state === "ready" ? <div className={styles.toolSummary}>
        {hasSubscriptionFilters ? <button className={styles.clearFilters} type="button" onClick={() => setSubscriptionFilters({ billing: "", nextReview: "", responsible: "", status: "" })}>Clear filters</button> : null}
        <span className={styles.count}>{filteredSubscriptions.length === registerState.subscriptions.length ? `${registerState.subscriptions.length} ${registerState.subscriptions.length === 1 ? "subscription" : "subscriptions"}` : `${filteredSubscriptions.length} of ${registerState.subscriptions.length} subscriptions`}</span>
      </div> : null}
    </div>

    {registerState.state === "loading" ? <div className={styles.loadingState}><LoaderCircle className={styles.spinner} size={22} aria-hidden="true" /><span>Loading subscriptions…</span></div> : null}
    {registerState.state === "error" ? <div className={styles.errorState} role="alert"><AlertCircle size={19} aria-hidden="true" /><div><strong>Subscriptions could not be loaded</strong><span>{registerState.message}</span></div><button className={styles.secondaryAction} type="button" onClick={() => void load()}><RefreshCw size={15} /> Retry</button></div> : null}
    {registerState.state === "ready" && !filteredSubscriptions.length ? <div className={styles.emptyState}><CreditCard size={25} aria-hidden="true" /><strong>{query || hasSubscriptionFilters ? "No subscriptions match those filters" : "No subscriptions have been added"}</strong><span>{readOnly ? "Subscription records will appear here when they are created by a System Admin." : "Start with the systems your staff use, then assign their owner and access."}</span>{!readOnly && !query && !hasSubscriptionFilters ? <button className={styles.secondaryAction} type="button" onClick={() => setShowAdd(true)}><Plus size={15} /> Add subscription</button> : null}</div> : null}
    {registerState.state === "ready" && filteredSubscriptions.length ? <div className={styles.sheetViewport}>
      <div className={styles.subscriptionSheet} role="table" aria-label="Subscriptions">
        <div className={`${styles.subscriptionSheetRow} ${styles.subscriptionSheetHeader}`} role="row">
          <SubscriptionSheetHeader label="Service" sortKey="service" activeSort={subscriptionSort} onSort={toggleSubscriptionSort} />
          <SubscriptionSheetHeader label="Monthly" sortKey="monthly" activeSort={subscriptionSort} onSort={toggleSubscriptionSort} filterKey="billing" filterOptions={subscriptionFilterOptions.billing} filterValue={subscriptionFilters.billing} isFilterOpen={activeSubscriptionFilter === "billing"} onToggleFilter={toggleSubscriptionFilter} onFilter={setSubscriptionFilter} />
          <SubscriptionSheetHeader label="Next review" sortKey="nextReview" activeSort={subscriptionSort} onSort={toggleSubscriptionSort} filterKey="nextReview" filterOptions={subscriptionFilterOptions.nextReview} filterValue={subscriptionFilters.nextReview} isFilterOpen={activeSubscriptionFilter === "nextReview"} onToggleFilter={toggleSubscriptionFilter} onFilter={setSubscriptionFilter} />
          <SubscriptionSheetHeader label="Responsible" sortKey="responsible" activeSort={subscriptionSort} onSort={toggleSubscriptionSort} filterKey="responsible" filterOptions={subscriptionFilterOptions.responsible} filterValue={subscriptionFilters.responsible} isFilterOpen={activeSubscriptionFilter === "responsible"} onToggleFilter={toggleSubscriptionFilter} onFilter={setSubscriptionFilter} />
          <SubscriptionSheetHeader label="Status" sortKey="status" activeSort={subscriptionSort} onSort={toggleSubscriptionSort} filterKey="status" filterOptions={subscriptionFilterOptions.status} filterValue={subscriptionFilters.status} isFilterOpen={activeSubscriptionFilter === "status"} onToggleFilter={toggleSubscriptionFilter} onFilter={setSubscriptionFilter} />
          <SubscriptionSheetHeader label="Access" sortKey="members" activeSort={subscriptionSort} onSort={toggleSubscriptionSort} />
          <div className={styles.sheetHeaderCell} role="columnheader"><span>Actions</span></div>
        </div>
        {filteredSubscriptions.map((subscription) => <div className={styles.subscriptionSheetRow} key={subscription.id} role="row">
          <div className={`${styles.sheetCell} ${styles.serviceCell}`} role="cell" data-label="Service">
            <div className={styles.subscriptionIcon}><CreditCard size={18} aria-hidden="true" /></div>
            <div className={styles.subscriptionIdentity}><strong>{subscription.serviceName}</strong>{subscription.planName ? <span title={subscription.planName}>{subscription.planName}</span> : null}</div>
          </div>
          <div className={`${styles.sheetCell} ${styles.monthlyCell}`} role="cell" data-label="Monthly"><strong>{monthlyCostLabel(subscription)}</strong></div>
          <div className={`${styles.sheetCell} ${styles.reviewCell}`} role="cell" data-label="Next review" data-due={isReviewDue(subscription)}><strong>{hasQuarterlyReview(subscription) ? formatDate(subscription.nextReviewOn) : <><span aria-hidden="true">—</span><span className={styles.visuallyHidden}>No quarterly review scheduled</span></>}</strong></div>
          <div className={`${styles.sheetCell} ${styles.responsibleCell}`} role="cell" data-label="Responsible"><strong>{subscription.responsible.fullName}</strong></div>
          <div className={`${styles.sheetCell} ${styles.statusCell}`} role="cell" data-label="Status"><span data-status={subscription.status}>{subscription.status}</span></div>
          <div className={`${styles.sheetCell} ${styles.membersCell}`} role="cell" data-label="Access"><strong title={`${subscription.memberNames.length} ${subscription.memberNames.length === 1 ? "person" : "people"} assigned`}>{subscription.memberNames.length || "—"}</strong></div>
          <div className={`${styles.sheetCell} ${styles.subscriptionActions}`} role="cell" data-label="Actions">
            {!readOnly ? <button type="button" onClick={() => setEditTarget(subscription)} disabled={reviewingId !== null}><Pencil size={15} /> Edit</button> : <span className={styles.readOnlyCell} aria-label="Read only">—</span>}
          </div>
        </div>)}
      </div>
    </div> : null}

    {showAdd ? <SubscriptionModal people={people} onClose={() => setShowAdd(false)} onCreated={subscriptionCreated} /> : null}
    {editTarget ? <SubscriptionModal people={people} subscription={editTarget} onClose={() => setEditTarget(null)} onUpdated={(next) => { replaceSubscription(next, `${next.serviceName} has been updated.`); setEditTarget(null); }} onReview={() => recordReview(editTarget)} /> : null}
  </section>;
}

function SubscriptionModal({
  people,
  subscription,
  onClose,
  onCreated,
  onUpdated,
  onReview,
}: {
  people: SubscriptionPerson[];
  subscription?: Subscription;
  onClose: () => void;
  onCreated?: (subscription: Subscription) => void;
  onUpdated?: (subscription: Subscription) => void;
  onReview?: () => Promise<void>;
}) {
  const isEditing = Boolean(subscription);
  const dialogRef = useRef<HTMLElement>(null);
  const initialFocusRef = useRef<HTMLInputElement>(null);
  const [pricingModel, setPricingModel] = useState<SubscriptionPricingModel>(subscription?.pricingModel ?? "free");
  const [memberPersonIds, setMemberPersonIds] = useState<string[]>(subscription?.memberPersonIds ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const closeWhenReady = useCallback(() => { if (!saving) onClose(); }, [onClose, saving]);
  useDialogFocus(true, dialogRef, initialFocusRef, closeWhenReady);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const form = new FormData(event.currentTarget);
    const amountText = String(form.get("amount") ?? "");
    const amountCents = pricingModel === "paid" ? amountToCents(amountText) : null;
    if (pricingModel === "paid" && amountCents === null) {
      setError("Enter a paid subscription amount using dollars and cents.");
      return;
    }
    const baseInput: CreateSubscriptionInput = {
      serviceName: String(form.get("serviceName") ?? ""),
      planName: String(form.get("planName") ?? ""),
      pricingModel,
      billingCycle: pricingModel === "paid" ? String(form.get("billingCycle") ?? "") as SubscriptionBillingCycle : undefined,
      amountCents,
      renewalDate: String(form.get("renewalDate") ?? "") || null,
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

  return <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeWhenReady()}>
    <section className={styles.modal} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="subscription-dialog-title" tabIndex={-1}>
      <header><div><span>Subscription register</span><h2 id="subscription-dialog-title">{isEditing ? "Edit subscription" : "Add subscription"}</h2><p>{isEditing ? `${subscription?.subscriptionCode} · ${quarterlyReviewHint(subscription)}` : "Add the service, responsible person and employees who use it."}</p></div><button type="button" onClick={closeWhenReady} disabled={saving} aria-label="Close subscription form"><X size={19} /></button></header>
      <form onSubmit={submit}>
        <div className={styles.formGrid}>
          <label><span>Service name <b aria-hidden="true">*</b></span><input name="serviceName" ref={initialFocusRef} required maxLength={160} defaultValue={subscription?.serviceName ?? ""} placeholder="Microsoft 365, Adobe Creative Cloud…" /></label>
          <label><span>Plan <small>Optional</small></span><input name="planName" maxLength={160} defaultValue={subscription?.planName ?? ""} placeholder="Business Standard, Teams…" /></label>
        </div>
        {isEditing ? <label><span>Status <b aria-hidden="true">*</b></span><select name="status" defaultValue={subscription?.status ?? "active"}><option value="active">Active</option><option value="paused">Paused</option><option value="cancelled">Cancelled</option></select></label> : null}
        <fieldset className={styles.pricingFieldset}><legend>Pricing</legend><div className={styles.pricingChoices}><label><input type="radio" name="pricingModel" value="free" checked={pricingModel === "free"} onChange={() => setPricingModel("free")} /> Free</label><label><input type="radio" name="pricingModel" value="paid" checked={pricingModel === "paid"} onChange={() => setPricingModel("paid")} /> Paid</label></div>{pricingModel === "paid" ? <div className={styles.formGrid}><label><span>Billing cycle <b aria-hidden="true">*</b></span><select name="billingCycle" required defaultValue={subscription?.billingCycle ?? "monthly"}>{SUBSCRIPTION_BILLING_CYCLES.map((cycle) => <option key={cycle} value={cycle}>{billingCycleLabels[cycle]}</option>)}</select></label><label><span>Amount (AUD) <b aria-hidden="true">*</b></span><input name="amount" inputMode="decimal" required defaultValue={centsToAmount(subscription?.amountCents ?? null)} placeholder="0.00" /></label></div> : <p className={styles.formHelp}><CircleDollarSign size={15} /> This is recorded as a free service. No amount or billing cycle is stored.</p>}</fieldset>
        <div className={styles.formGrid}>
          <label><span>Renewal date <small>Optional</small></span><input name="renewalDate" type="date" defaultValue={subscription?.renewalDate ?? ""} /></label>
          <label><span>Responsible person <b aria-hidden="true">*</b></span><EmployeePicker assignees={people} defaultValue={subscription?.responsible.personId ?? ""} name="responsiblePersonId" disabled={!people.length} /></label>
        </div>
        <SubscriptionMemberPicker people={people} selectedIds={memberPersonIds} onChange={setMemberPersonIds} />
        <p className={styles.formHelp}><CalendarClock size={15} /> All paid subscriptions are reviewed together on the first weekday (Monday–Friday) of each calendar quarter.</p>
        {error ? <p className={styles.inlineError} role="alert"><AlertCircle size={15} />{error}</p> : null}
        <footer><button className={styles.secondaryAction} type="button" onClick={closeWhenReady} disabled={saving}>Cancel</button>{isEditing && onReview && subscription && hasQuarterlyReview(subscription) ? <button className={styles.secondaryAction} type="button" onClick={() => void reviewNow()} disabled={saving}>{saving ? <LoaderCircle className={styles.spinner} size={16} /> : <CalendarClock size={16} />}{saving ? "Saving…" : "Mark review complete"}</button> : null}<button className={styles.primaryAction} type="submit" disabled={saving || !people.length}>{saving ? <LoaderCircle className={styles.spinner} size={16} /> : <CreditCard size={16} />}{saving ? "Saving…" : isEditing ? "Save changes" : "Add subscription"}</button></footer>
      </form>
    </section>
  </div>;
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
  const filteredPeople = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return people.filter((person) => !term || [person.fullName, person.positionTitle, person.teamName, person.company].join(" ").toLocaleLowerCase().includes(term));
  }, [people, query]);

  function toggle(personId: string) {
    onChange(selected.has(personId) ? selectedIds.filter((id) => id !== personId) : [...selectedIds, personId]);
  }

  return <fieldset className={styles.membersFieldset}><legend>Who has access <small>Optional</small></legend><p>Employees only see subscriptions assigned to them. You can search and choose more than one person.</p><label className={styles.memberSearch}><Search size={15} aria-hidden="true" /><span className={styles.visuallyHidden}>Search employees for subscription access</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search employees" type="search" /></label><div className={styles.memberSummary}>{selectedIds.length} {selectedIds.length === 1 ? "employee selected" : "employees selected"}</div><div className={styles.memberList} id={listId}>{filteredPeople.length ? filteredPeople.map((person) => <label className={styles.memberOption} key={person.personId}><input checked={selected.has(person.personId)} onChange={() => toggle(person.personId)} type="checkbox" /><span><strong>{person.fullName}</strong><small>{[person.positionTitle, person.teamName].filter(Boolean).join(" · ")}</small></span></label>) : <p className={styles.memberEmpty}>No employees match that search.</p>}</div></fieldset>;
}
