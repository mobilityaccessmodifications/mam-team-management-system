"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { loadSubscriptionRequests, mutateSubscriptionRequest } from "@/app/subscription-requests/actions";
import { parseRequestAmount, formatRequestAmount, withSelectedRequestCost } from "@/lib/subscription-request-form";
import { validateRequestPayload, type RequestEvidence, type RequestPayload, type RequestWorkspace } from "@/lib/subscription-request-types";
import styles from "./subscription-register.module.css";

type RequestContext = Pick<RequestWorkspace, "enabled" | "canApply" | "requestFormVersion" | "viewerName">;
type ComposerOptions = { formRef: RefObject<HTMLFormElement | null>; onSubmitted: (service: string) => void; onDenied: () => void };

async function encodeEvidence(files: File[]): Promise<RequestEvidence[] | undefined> {
  if (!files.length) return undefined;
  if (files.length > 3 || files.reduce((size, file) => size + file.size, 0) > 500000) throw new Error("Use at most three evidence files, 500 KB total.");
  if (files.some(file => !["application/pdf", "image/png", "image/jpeg"].includes(file.type))) throw new Error("Use PDF, PNG or JPEG evidence.");
  return Promise.all(files.map(file => new Promise<RequestEvidence>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Evidence could not be read."));
    reader.onload = () => resolve({ name: file.name, mime: file.type, base64: String(reader.result).split(",")[1] });
    reader.readAsDataURL(file);
  })));
}

export function usePaidSubscriptionRequest({ formRef, onSubmitted, onDenied }: ComposerOptions) {
  const [context, setContext] = useState<RequestContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [posting, setPosting] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState("");
  const [billing, setBilling] = useState("annual");
  const [payment, setPayment] = useState("card");
  const [category, setCategory] = useState("subscription");
  const busyRef = useRef(false);
  const uncertainRef = useRef(false);
  const deniedRef = useRef(false);
  const contextRef = useRef<RequestContext | null>(null);
  const idRef = useRef<string | null>(null);
  const versionRef = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const isLocked = useCallback(() => busyRef.current || uncertainRef.current, []);

  function deny(message: string) {
    deniedRef.current = true;
    contextRef.current = null;
    uncertainRef.current = false;
    setContext(null); setDenied(true); setUncertain(false); setError(message);
    formRef.current?.reset();
    setBilling("annual"); setPayment("card"); setCategory("subscription");
    onDenied();
  }

  async function load(reconcile = false) {
    if (busyRef.current || deniedRef.current || (!reconcile && contextRef.current)) return;
    busyRef.current = true; setLoading(true); setError("");
    try {
      const result = await loadSubscriptionRequests();
      if (!mounted.current) return;
      if (!result.ok) {
        if (result.denied) deny(result.message); else setError(result.message);
        return;
      }
      const row = reconcile ? result.data.requests.find(item => item.id === idRef.current) : null;
      if (row && ["submitted", "approved"].includes(row.status)) { onSubmitted(row.payload.service ?? "Subscription"); return; }
      if (!result.data.enabled || !result.data.canApply || result.data.requestFormVersion !== 3) { setContext(null); contextRef.current = null; setError("Subscription requests are unavailable."); return; }
      const next = { enabled: result.data.enabled, canApply: result.data.canApply, requestFormVersion: result.data.requestFormVersion, viewerName: result.data.viewerName };
      contextRef.current = next; setContext(next);
      idRef.current ??= crypto.randomUUID();
      if (row) {
        if (!row.canEdit) { deny("This request can no longer be edited."); return; }
        versionRef.current = row.version;
        const restored: Record<string, string> = {
          serviceName: row.payload.service ?? "", planName: row.payload.plan ?? "", company: row.payload.company ?? "", startDate: row.payload.startDate ?? "",
          requestPurpose: row.payload.purpose ?? "", requestIntendedUsers: row.payload.intendedUsers ?? "", requestDuration: row.payload.duration ?? "ongoing",
          requestWebsite: row.payload.websiteUrl ?? "", requestFrequency: row.payload.usageFrequency ?? "", requestComparison: row.payload.comparisonUnavailableReason ?? "",
          requestMonthly: formatRequestAmount(row.payload.monthlyCostCents), requestAnnual: formatRequestAmount(row.payload.annualCostCents), requestOneOff: formatRequestAmount(row.payload.oneOffCostCents),
          requestCardLabel: row.payload.cardLabel ?? "", requestCardHolder: row.payload.cardHolder ?? "", requestInvoiceEmail: row.payload.invoiceEmail ?? "", requestInvoiceContact: row.payload.invoiceContact ?? "",
        };
        for (const [name, value] of Object.entries(restored)) {
          const control = formRef.current?.elements.namedItem(name);
          if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement) control.value = value;
        }
        const evidence = formRef.current?.elements.namedItem("requestEvidence");
        if (evidence instanceof HTMLInputElement) evidence.value = "";
        setBilling(row.payload.billing ?? "annual"); setPayment(row.payload.payment ?? "card"); setCategory(row.payload.category ?? "subscription");
      }
      uncertainRef.current = false; setUncertain(false);
    } catch { if (mounted.current) setError("Requests could not be loaded. Try again."); }
    finally { busyRef.current = false; if (mounted.current) setLoading(false); }
  }

  async function submit(form: FormData) {
    if (busyRef.current || uncertainRef.current || deniedRef.current || !contextRef.current?.enabled || !contextRef.current.canApply || !idRef.current) return;
    busyRef.current = true; setPosting(true); setError("");
    let dispatched = false;
    try {
      const text = (name: string) => String(form.get(name) ?? "").trim();
      const version = contextRef.current.requestFormVersion === 3 ? 3 : 2;
      const payload: RequestPayload = withSelectedRequestCost({
        formVersion: version, kind: "new_purchase", service: text("serviceName"), plan: text("planName"), company: text("company"), startDate: text("startDate"),
        purpose: text("requestPurpose"), intendedUsers: text("requestIntendedUsers"), duration: text("requestDuration"), billing, currency: "AUD", payment,
        monthlyCostCents: billing === "one_off" ? null : parseRequestAmount(text("requestMonthly")),
        annualCostCents: billing === "one_off" ? null : parseRequestAmount(text("requestAnnual")), comparisonUnavailableReason: text("requestComparison"),
        ...(payment === "card" ? { cardLabel: text("requestCardLabel"), cardHolder: text("requestCardHolder") } : {}),
        ...(version === 3 ? { category, websiteUrl: text("requestWebsite"), usageFrequency: text("requestFrequency"), oneOffCostCents: parseRequestAmount(text("requestOneOff")),
          ...(payment === "invoice" ? { invoiceEmail: text("requestInvoiceEmail"), invoiceContact: text("requestInvoiceContact") } : {}) } : {}),
      });
      validateRequestPayload(payload, true);
      const files = form.getAll("requestEvidence").filter((file): file is File => file instanceof File && file.size > 0);
      const evidence = await encodeEvidence(files);
      dispatched = true;
      const result = await mutateSubscriptionRequest({ id: idRef.current, version: versionRef.current, operation: "submit", payload, evidence });
      if (!mounted.current) return;
      if (!result.ok) {
        if (result.denied) deny(result.message);
        else {
          uncertainRef.current = result.uncertain === true || result.message.includes("Reload");
          setUncertain(uncertainRef.current); setError(result.message);
        }
        return;
      }
      versionRef.current = result.data.version;
      onSubmitted(result.data.payload.service ?? payload.service ?? "Subscription");
    } catch (reason) {
      if (!mounted.current) return;
      uncertainRef.current = dispatched; setUncertain(dispatched);
      setError(dispatched ? "The request could not be confirmed. Reload before retrying." : reason instanceof Error ? reason.message : "Check the request fields.");
    } finally { busyRef.current = false; if (mounted.current) setPosting(false); }
  }

  return { context, loading, posting, uncertain, denied, error, billing, payment, category, setBilling, setPayment, setCategory, isLocked, load, submit,
    ready: Boolean(context?.enabled && context.canApply && !loading && !denied && !uncertain) };
}

type Composer = ReturnType<typeof usePaidSubscriptionRequest>;
export function PaidSubscriptionRequestFields({ composer }: { composer: Composer }) {
  const { context, billing, payment, category, setBilling, setPayment, setCategory } = composer;
  if (!context || composer.denied) return null;
  const version3 = context.requestFormVersion === 3;
  return <div className={styles.paidExpansion}>
    <fieldset className={styles.requestGroup}>
      <legend>Request details</legend>
      <div className={styles.formGrid}>
        <label><span>Requested by</span><input value={context.viewerName ?? ""} readOnly /></label>
        {version3 ? <label><span>Category</span><select name="requestCategory" value={category} onChange={event => { setCategory(event.target.value); if (event.target.value === "one_off_service") setBilling("one_off"); }}><option value="subscription">Subscription</option><option value="software_app">Software / App</option><option value="hardware">Hardware</option><option value="one_off_service">One-off service</option></select></label> : null}
        <label className={styles.fullWidth}><span>Purpose <b aria-hidden="true">*</b></span><textarea name="requestPurpose" rows={2} required maxLength={4000} /></label>
        {version3 ? <label className={styles.fullWidth}><span>Website link <small>Optional</small></span><input name="requestWebsite" type="url" maxLength={2048} /></label> : null}
        <label className={styles.fullWidth}><span>Intended users <b aria-hidden="true">*</b></span><textarea name="requestIntendedUsers" rows={2} required maxLength={4000} /></label>
        <label><span>Expected usage <b aria-hidden="true">*</b></span><select name="requestDuration" defaultValue="ongoing"><option value="ongoing">Ongoing</option><option value="3_months">3 months</option><option value="12_months">12 months</option></select></label>
        {version3 ? <label><span>Usage frequency <small>Optional</small></span><input name="requestFrequency" maxLength={4000} /></label> : null}
      </div>
    </fieldset>
    <fieldset className={styles.requestGroup}>
      <legend>Costs</legend>
      <div className={styles.formGrid}>
        <fieldset className={styles.conditionalFields} hidden={billing === "one_off"} disabled={billing === "one_off"}>
          <label><span>Monthly cost (AUD)</span><input name="requestMonthly" inputMode="decimal" placeholder="0.00" /></label>
          <label><span>Annual cost (AUD)</span><input name="requestAnnual" inputMode="decimal" placeholder="0.00" /></label>
        </fieldset>
        <label><span>Preferred billing <b aria-hidden="true">*</b></span><select name="requestBilling" value={billing} onChange={event => setBilling(event.target.value)}><option value="monthly">Paid monthly</option><option value="annual">Paid annually</option>{version3 ? <option value="one_off">One-off</option> : null}</select></label>
        {version3 ? <label><span>One-off cost (AUD) <small>{billing === "one_off" ? "Required" : "Optional"}</small></span><input name="requestOneOff" inputMode="decimal" placeholder="0.00" required={billing === "one_off"} /></label> : null}
        <label className={styles.fullWidth} hidden={billing === "one_off"}><span>Alternative quote unavailable reason <small>Optional</small></span><textarea name="requestComparison" rows={2} maxLength={4000} disabled={billing === "one_off"} /></label>
      </div>
    </fieldset>
    <fieldset className={styles.requestGroup}>
      <legend>Payment</legend>
      <div className={styles.formGrid}>
        <label className={styles.fullWidth}><span>Payment method <b aria-hidden="true">*</b></span><select name="requestPayment" value={payment} onChange={event => setPayment(event.target.value)}><option value="card">Card</option>{version3 ? <><option value="invoice">Invoice</option><option value="direct_debit">Direct debit</option></> : <option value="non_card">Non-card</option>}</select></label>
        <fieldset className={styles.conditionalFields} hidden={payment !== "card"} disabled={payment !== "card"}>
          <label><span>Card label <b aria-hidden="true">*</b></span><input name="requestCardLabel" maxLength={160} required={payment === "card"} /></label>
          <label><span>Card holder <b aria-hidden="true">*</b></span><input name="requestCardHolder" maxLength={160} required={payment === "card"} /></label>
        </fieldset>
        {version3 ? <fieldset className={styles.conditionalFields} hidden={payment !== "invoice"} disabled={payment !== "invoice"}>
          <label><span>Invoice email <small>Optional</small></span><input name="requestInvoiceEmail" type="email" maxLength={254} /></label>
          <label><span>Invoice contact <small>Optional</small></span><input name="requestInvoiceContact" maxLength={160} /></label>
        </fieldset> : null}
        <label className={styles.fullWidth}><span>Evidence <small>PDF, PNG, JPEG</small></span><input name="requestEvidence" type="file" accept="application/pdf,image/png,image/jpeg" multiple /></label>
      </div>
    </fieldset>
  </div>;
}
