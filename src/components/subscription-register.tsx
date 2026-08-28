"use client";

import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  CircleDollarSign,
  CreditCard,
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
  return subscription.status !== "cancelled" && subscription.nextReviewOn <= new Date().toISOString().slice(0, 10);
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

/** System Admin can manage; managers receive this exact register read-only. */
export function SubscriptionRegister({ readOnly = false }: { readOnly?: boolean }) {
  const [registerState, setRegisterState] = useState<RegisterState>({ state: "loading" });
  const [people, setPeople] = useState<SubscriptionPerson[]>([]);
  const [query, setQuery] = useState("");
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

  const filteredSubscriptions = useMemo(() => {
    if (registerState.state !== "ready") return [];
    const term = query.trim().toLocaleLowerCase();
    return registerState.subscriptions.filter((subscription) => !term || subscriptionSearchText(subscription).includes(term));
  }, [query, registerState]);

  function replaceSubscription(next: Subscription, message: string) {
    setRegisterState((current) => current.state !== "ready" ? current : {
      state: "ready",
      subscriptions: current.subscriptions.map((subscription) => subscription.id === next.id ? next : subscription),
    });
    setNotice(message);
  }

  function subscriptionCreated(next: Subscription) {
    setRegisterState((current) => current.state !== "ready" ? {
      state: "ready",
      subscriptions: [next],
    } : {
      state: "ready",
      subscriptions: [...current.subscriptions, next].sort((first, second) => first.nextReviewOn.localeCompare(second.nextReviewOn)),
    });
    setShowAdd(false);
    setNotice(`${next.serviceName} has been added. Its first quarterly review is ${formatDate(next.nextReviewOn)}.`);
  }

  async function completeReview(subscription: Subscription) {
    if (reviewingId) return;
    setReviewingId(subscription.id);
    try {
      replaceSubscription(await markSubscriptionReviewed({
        subscriptionId: subscription.id,
        version: subscription.version,
      }), `Quarterly review recorded for ${subscription.serviceName}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The review could not be recorded.");
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
      {registerState.state === "ready" ? <span className={styles.count}>{filteredSubscriptions.length} {filteredSubscriptions.length === 1 ? "subscription" : "subscriptions"}</span> : null}
    </div>

    {registerState.state === "loading" ? <div className={styles.loadingState}><LoaderCircle className={styles.spinner} size={22} aria-hidden="true" /><span>Loading subscriptions…</span></div> : null}
    {registerState.state === "error" ? <div className={styles.errorState} role="alert"><AlertCircle size={19} aria-hidden="true" /><div><strong>Subscriptions could not be loaded</strong><span>{registerState.message}</span></div><button className={styles.secondaryAction} type="button" onClick={() => void load()}><RefreshCw size={15} /> Retry</button></div> : null}
    {registerState.state === "ready" && !filteredSubscriptions.length ? <div className={styles.emptyState}><CreditCard size={25} aria-hidden="true" /><strong>{query ? "No subscriptions match that search" : "No subscriptions have been added"}</strong><span>{readOnly ? "Subscription records will appear here when they are created by a System Admin." : "Start with the systems your staff use, then assign their owner and access."}</span>{!readOnly && !query ? <button className={styles.secondaryAction} type="button" onClick={() => setShowAdd(true)}><Plus size={15} /> Add subscription</button> : null}</div> : null}
    {registerState.state === "ready" && filteredSubscriptions.length ? <div className={styles.subscriptionList} role="list">
      {filteredSubscriptions.map((subscription) => <article className={styles.subscriptionRow} key={subscription.id} role="listitem">
        <div className={styles.subscriptionIcon}><CreditCard size={18} aria-hidden="true" /></div>
        <div className={styles.subscriptionIdentity}><strong>{subscription.serviceName}</strong><span>{subscription.planName || "Plan not recorded"}</span><code>{subscription.subscriptionCode}</code></div>
        <div className={styles.subscriptionTerms}><span>{subscription.pricingModel === "free" ? "Free" : `${formatCurrency(subscription.amountCents)} · ${subscription.billingCycle ? billingCycleLabels[subscription.billingCycle] : "Paid"}`}</span><strong data-status={subscription.status}>{subscription.status}</strong></div>
        <div className={styles.responsible}><span>Responsible</span><strong>{subscription.responsible.fullName}</strong><small>{subscription.responsible.positionTitle}</small></div>
        <div className={styles.reviewDate} data-due={isReviewDue(subscription)}><span>Next review</span><strong>{formatDate(subscription.nextReviewOn)}</strong><small>{subscription.memberNames.length} {subscription.memberNames.length === 1 ? "person" : "people"} assigned</small></div>
        {!readOnly ? <div className={styles.rowActions}>
          <button type="button" onClick={() => setEditTarget(subscription)} disabled={reviewingId !== null}><Pencil size={15} /> Edit</button>
          <button type="button" onClick={() => void completeReview(subscription)} disabled={reviewingId !== null || subscription.status === "cancelled"} title={subscription.status === "cancelled" ? "Cancelled subscriptions do not need review" : undefined}>{reviewingId === subscription.id ? <LoaderCircle className={styles.spinner} size={15} /> : <CalendarClock size={15} />} {reviewingId === subscription.id ? "Saving…" : "Review"}</button>
        </div> : null}
      </article>)}
    </div> : null}

    {showAdd ? <SubscriptionModal people={people} onClose={() => setShowAdd(false)} onCreated={subscriptionCreated} /> : null}
    {editTarget ? <SubscriptionModal people={people} subscription={editTarget} onClose={() => setEditTarget(null)} onUpdated={(next) => { replaceSubscription(next, `${next.serviceName} has been updated.`); setEditTarget(null); }} /> : null}
  </section>;
}

function SubscriptionModal({
  people,
  subscription,
  onClose,
  onCreated,
  onUpdated,
}: {
  people: SubscriptionPerson[];
  subscription?: Subscription;
  onClose: () => void;
  onCreated?: (subscription: Subscription) => void;
  onUpdated?: (subscription: Subscription) => void;
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

  return <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeWhenReady()}>
    <section className={styles.modal} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="subscription-dialog-title" tabIndex={-1}>
      <header><div><span>Subscription register</span><h2 id="subscription-dialog-title">{isEditing ? "Edit subscription" : "Add subscription"}</h2><p>{isEditing ? `${subscription?.subscriptionCode} · Quarterly reviews remain database scheduled.` : "Add the service, responsible person and employees who use it."}</p></div><button type="button" onClick={closeWhenReady} disabled={saving} aria-label="Close subscription form"><X size={19} /></button></header>
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
        <p className={styles.formHelp}><CalendarClock size={15} /> The first review is automatically set three months from today. Marking a review complete schedules the next quarterly review.</p>
        {error ? <p className={styles.inlineError} role="alert"><AlertCircle size={15} />{error}</p> : null}
        <footer><button className={styles.secondaryAction} type="button" onClick={closeWhenReady} disabled={saving}>Cancel</button><button className={styles.primaryAction} type="submit" disabled={saving || !people.length}>{saving ? <LoaderCircle className={styles.spinner} size={16} /> : <CreditCard size={16} />}{saving ? "Saving…" : isEditing ? "Save changes" : "Add subscription"}</button></footer>
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
