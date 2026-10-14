export type RequestStatus = "draft" | "submitted" | "returned" | "approved" | "rejected" | "withdrawn";
export type RequestOperation = "save" | "submit" | "approve" | "return" | "reject" | "withdraw";
export type RequestPayload = {
  kind?: string; service?: string; plan?: string; purpose?: string; company?: string;
  payer?: string; duration?: string; billing?: string; currency?: string; tax?: string;
  quoteCents?: number | null; noQuoteReason?: string; audEstimateCents?: number | null;
  payment?: string; cardLabel?: string; cardHolder?: string;
  responsiblePersonId?: string | null; intendedUsers?: string;
};
export type RequestEvidence = { name: string; mime: string; base64: string };
export type RequestEvent = { version: number; operation: string; actor: string; at: string; payload: RequestPayload; reason: string; evidence: { name: string; mime: string; bytes: number }[] };
export type SubscriptionRequest = { id: string; applicant: string; status: RequestStatus; version: number; revision: number; evidenceVersion: number; payload: RequestPayload; events: RequestEvent[]; evidence: { name: string; mime: string; bytes: number }[]; canEdit: boolean; canDecide: boolean; canWithdraw: boolean };
export type RequestWorkspace = { canApply: boolean; enabled: boolean; requests: SubscriptionRequest[]; people: { id: string; name: string }[] };
export type RequestResult<T> = { ok: true; data: T; committed?: boolean } | { ok: false; message: string; denied: boolean; uncertain?: boolean };
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields = ["kind","service","plan","purpose","company","payer","duration","billing","currency","tax","quoteCents","noQuoteReason","audEstimateCents","payment","cardLabel","cardHolder","responsiblePersonId","intendedUsers"];
export function validateRequestPayload(input: unknown, submission: boolean): RequestPayload {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Request fields are invalid.");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !fields.includes(key))) throw new Error("Unsupported request field.");
  for (const [key, item] of Object.entries(value)) {
    if (["quoteCents","audEstimateCents"].includes(key)) {
      if (item !== null && (!Number.isSafeInteger(item) || (item as number) < 0 || (item as number) > 100_000_000)) throw new Error("Enter a valid amount in cents.");
    } else if (key === "responsiblePersonId") {
      if (item !== null && (typeof item !== "string" || !UUID.test(item))) throw new Error("Responsible person is invalid.");
    } else if (typeof item !== "string" || item.length > 4000) throw new Error("Request text is invalid.");
  }
  for (const [key, allowed] of Object.entries({ kind:["new_purchase","renewal","added_seats","plan_change"], company:["mam","equipsy","both"], billing:["monthly","annual","one_off","other"], payment:["card","non_card"] })) {
    if (value[key] !== undefined && !allowed.includes(value[key] as string)) throw new Error("Request selection is invalid.");
  }
  if (value.currency !== undefined && !/^[A-Z]{3}$/.test(value.currency as string)) throw new Error("Currency is invalid.");
  if (submission) {
    for (const key of ["kind","service","purpose","company","payer","duration","billing","currency","tax","payment","intendedUsers"]) {
      if (typeof value[key] !== "string" || !(value[key] as string).trim()) throw new Error("Complete the required request fields.");
    }
    if (value.quoteCents == null && !(typeof value.noQuoteReason === "string" && value.noQuoteReason.trim())) throw new Error("Provide a quote or explain why it is missing.");
    if (value.audEstimateCents == null) throw new Error("Provide the AUD estimate.");
    if (value.payment === "card" && !(typeof value.cardLabel === "string" && value.cardLabel.trim() && typeof value.cardHolder === "string" && value.cardHolder.trim())) throw new Error("Provide the card label and holder, not card numbers.");
  }
  return value as RequestPayload;
}
