export type RequestStatus = "draft" | "submitted" | "returned" | "approved" | "rejected" | "withdrawn";
export type RequestOperation = "save" | "submit" | "approve" | "return" | "reject" | "withdraw";
export type RequestPayload = {
  formVersion?: 2; monthlyCostCents?: number | null; annualCostCents?: number | null; comparisonUnavailableReason?: string;
  kind?: string; service?: string; plan?: string; purpose?: string; company?: string;
  payer?: string; duration?: string; billing?: string; currency?: string; tax?: string;
  quoteCents?: number | null; noQuoteReason?: string; audEstimateCents?: number | null;
  payment?: string; cardLabel?: string; cardHolder?: string;
  responsiblePersonId?: string | null; intendedUsers?: string;
};
export type RequestEvidence = { name: string; mime: string; base64: string };
export type RequestActivation = { id: string; version: number; seatCount: number; billingAnchorDate: string; renewalDate: string; responsiblePersonId: string; memberPersonIds: string[] };
export type RequestEvent = { version: number; operation: string; actor: string; at: string; payload: RequestPayload; reason: string; evidence: { name: string; mime: string; bytes: number }[] };
export type SubscriptionRequest = { id: string; applicant: string; applicantName?: string; linkedSubscriptionId?: string | null; canActivate?: boolean; status: RequestStatus; version: number; revision: number; evidenceVersion: number; payload: RequestPayload; events: RequestEvent[]; evidence: { name: string; mime: string; bytes: number }[]; canEdit: boolean; canDecide: boolean; canWithdraw: boolean };
export type RequestWorkspace = { canApply: boolean; enabled: boolean; viewerName?: string; viewerPersonId?: string | null; canManageCredentials?: boolean; requests: SubscriptionRequest[]; people: { id: string; name: string }[] };
export type RequestResult<T> = { ok: true; data: T; committed?: boolean } | { ok: false; message: string; denied: boolean; uncertain?: boolean };
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields = ["formVersion","monthlyCostCents","annualCostCents","comparisonUnavailableReason","kind","service","plan","purpose","company","payer","duration","billing","currency","tax","quoteCents","noQuoteReason","audEstimateCents","payment","cardLabel","cardHolder","responsiblePersonId","intendedUsers"];
export function validateRequestPayload(input: unknown, submission: boolean): RequestPayload {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Request fields are invalid.");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !fields.includes(key))) throw new Error("Unsupported request field.");
  for (const [key, item] of Object.entries(value)) {
    if (key === "formVersion") {
      if (item !== 2) throw new Error("Request form version is invalid.");
    } else if (["quoteCents","audEstimateCents","monthlyCostCents","annualCostCents"].includes(key)) {
      if (item !== null && (!Number.isSafeInteger(item) || (item as number) < 0 || (item as number) > 100_000_000)) throw new Error("Enter a valid amount in cents.");
    } else if (key === "responsiblePersonId") {
      if (item !== null && (typeof item !== "string" || !UUID.test(item))) throw new Error("Responsible person is invalid.");
    } else if (typeof item !== "string" || item.length > 4000) throw new Error("Request text is invalid.");
  }
  for (const [key, allowed] of Object.entries({ kind:["new_purchase","renewal","added_seats","plan_change"], company:["mam","equipsy","both"], billing:["monthly","annual","one_off","other"], payment:["card","non_card"] })) {
    if (value[key] !== undefined && !allowed.includes(value[key] as string)) throw new Error("Request selection is invalid.");
  }
  if (value.currency !== undefined && !/^[A-Z]{3}$/.test(value.currency as string)) throw new Error("Currency is invalid.");
  if (value.formVersion === 2) {
    if (value.service !== undefined && (value.service as string).length > 160) throw new Error("Service name is too long.");
    for (const key of ["cardLabel","cardHolder"]) if (value[key] !== undefined && (value[key] as string).length > 160) throw new Error("Card label or holder is too long.");
    if ((value.billing !== undefined && !["monthly","annual"].includes(value.billing as string)) || (value.duration !== undefined && !["ongoing","3_months","12_months"].includes(value.duration as string)) || (value.currency !== undefined && value.currency !== "AUD") || (value.kind !== undefined && value.kind !== "new_purchase")) throw new Error("Request selection is invalid.");
  }
  if (submission) {
    const required = value.formVersion === 2 ? ["kind","service","purpose","company","duration","billing","currency","payment","intendedUsers"] : ["kind","service","purpose","company","payer","duration","billing","currency","tax","payment","intendedUsers"];
    for (const key of required) {
      if (typeof value[key] !== "string" || !(value[key] as string).trim()) throw new Error("Complete the required request fields.");
    }
    if (value.formVersion === 2) {
      const selected = value.billing === "monthly" ? value.monthlyCostCents : value.annualCostCents;
      const alternative = value.billing === "monthly" ? value.annualCostCents : value.monthlyCostCents;
      if (selected == null) throw new Error("Provide the cost for the selected billing option.");
      if (alternative == null && !(typeof value.comparisonUnavailableReason === "string" && value.comparisonUnavailableReason.trim())) throw new Error("Provide both costs or explain why the alternative quote is unavailable.");
      if (value.quoteCents !== selected || value.audEstimateCents !== selected) throw new Error("Selected billing cost is invalid.");
    } else {
      if (value.quoteCents == null && !(typeof value.noQuoteReason === "string" && value.noQuoteReason.trim())) throw new Error("Provide a quote or explain why it is missing.");
      if (value.audEstimateCents == null) throw new Error("Provide the AUD estimate.");
    }
    if (value.payment === "card" && !(typeof value.cardLabel === "string" && value.cardLabel.trim() && typeof value.cardHolder === "string" && value.cardHolder.trim())) throw new Error("Provide the card label and holder, not card numbers.");
  }
  return value as RequestPayload;
}
