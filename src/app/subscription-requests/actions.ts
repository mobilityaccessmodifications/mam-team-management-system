"use server";

import { after } from "next/server";
import { dispatchSubscriptionRequestMail } from "@/lib/subscription-request-mail";

import { isAuthApiError, isAuthSessionMissingError } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { UUID, validateRequestPayload, validateRequestFinance, type RequestFinance, type RequestActivation, type RequestEvidence, type RequestOperation, type RequestResult, type RequestWorkspace, type SubscriptionRequest } from "@/lib/subscription-request-types";

const generic = "The request could not be confirmed. Reload before retrying.";
function failure(error: unknown, uncertain = false): RequestResult<never> {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const messages: Record<string, string> = { PT409:"Request changed. Reload before retrying.", "42501":"You do not have permission for this request.", "22023":"Check the request fields and decision reason.", "55000":"Requests or the designated approver are unavailable." };
  return { ok:false, message:messages[code] ?? generic, denied:code === "42501", uncertain:uncertain && !(code in messages) };
}
async function client() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser().catch((error: unknown) => ({data:{user:null},error:error || {}}));
  if (error) throw { code:isAuthSessionMissingError(error) || (isAuthApiError(error) && [401,403].includes(error.status)) ? "42501" : "" };
  if (!data.user) throw { code:"42501" };
  return supabase;
}
function validRequest(value: unknown): value is SubscriptionRequest {
  if (!value || typeof value !== "object") return false;
  const r = value as SubscriptionRequest;
  return typeof r.id === "string" && UUID.test(r.id) && Number.isSafeInteger(r.version) && r.version>0
    && ["draft","submitted","returned","approved","rejected","withdrawn"].includes(r.status)
    && Array.isArray(r.events) && Array.isArray(r.evidence) && typeof r.payload === "object" && r.payload !== null
    && [r.canEdit,r.canDecide,r.canWithdraw].every(v=>typeof v === "boolean")
    && (r.applicantName === undefined || typeof r.applicantName === "string")
    && (r.linkedSubscriptionId === undefined || r.linkedSubscriptionId === null || (typeof r.linkedSubscriptionId === "string" && UUID.test(r.linkedSubscriptionId)))
    && (r.canActivate === undefined || typeof r.canActivate === "boolean")
    && (r.canCompletePurchase === undefined || typeof r.canCompletePurchase === "boolean")
    && (r.requestedAt == null || typeof r.requestedAt === "string")
    && (r.completedAt == null || typeof r.completedAt === "string")
    && (r.completedByName == null || typeof r.completedByName === "string");
}
export async function loadSubscriptionRequests(): Promise<RequestResult<RequestWorkspace>> {
  try {
    const supabase = await client();
    const { data, error } = await supabase.rpc("sr_workspace");
    if (error) return failure(error);
    if (!data || typeof data.enabled !== "boolean" || typeof data.canApply !== "boolean" || !Array.isArray(data.requests) || !data.requests.every(validRequest) || !Array.isArray(data.people)
      || !data.people.every((p: {id?:unknown;name?:unknown}) => typeof p.id === "string" && UUID.test(p.id) && typeof p.name === "string")
      || (data.requestFormVersion !== undefined && ![2,3].includes(data.requestFormVersion))
      || (data.viewerName !== undefined && typeof data.viewerName !== "string")
      || (data.viewerPersonId !== undefined && data.viewerPersonId !== null && (typeof data.viewerPersonId !== "string" || !UUID.test(data.viewerPersonId)))
      || (data.canManageCredentials !== undefined && typeof data.canManageCredentials !== "boolean")) return failure(null);
    return { ok:true, data:data as RequestWorkspace };
  } catch (error) { return failure(error); }
}
export async function activateSubscriptionRequest(input: RequestActivation): Promise<RequestResult<SubscriptionRequest>> {
  let dispatched = false;
  try {
    const supabase = await client();
    const validDate = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
    if (!input || !UUID.test(input.id) || !Number.isSafeInteger(input.version) || input.version < 1 || !Number.isSafeInteger(input.seatCount) || input.seatCount < 1 || input.seatCount > 100000 || !validDate(input.billingAnchorDate) || !validDate(input.renewalDate) || input.renewalDate < input.billingAnchorDate || !UUID.test(input.responsiblePersonId) || !Array.isArray(input.memberPersonIds) || input.memberPersonIds.length > 1000 || input.memberPersonIds.some(id => typeof id !== "string" || !UUID.test(id)) || new Set(input.memberPersonIds).size !== input.memberPersonIds.length) return failure({code:"22023"});
    dispatched = true;
    const { data, error } = await supabase.rpc("sr_activate", { p_request_id:input.id, p_expected_request_version:input.version, p_seat_count:input.seatCount, p_billing_anchor_date:input.billingAnchorDate, p_renewal_date:input.renewalDate, p_responsible_person_id:input.responsiblePersonId, p_member_person_ids:input.memberPersonIds });
    if (error) return failure(error,true);
    if (!validRequest(data) || !data.linkedSubscriptionId || data.canActivate !== false) return failure(null,true);
    return {ok:true,data,committed:true};
  } catch(error) { return failure(error,dispatched); }
}
export async function mutateSubscriptionRequest(input: { id: string; version: number; operation: RequestOperation; payload?: unknown; reason?: string; evidence?: RequestEvidence[]; finance?: RequestFinance }): Promise<RequestResult<SubscriptionRequest>> {
  let dispatched = false;
  try {
    const supabase = await client();
    if (!input || !UUID.test(input.id) || !Number.isSafeInteger(input.version) || input.version<0 || !["save","submit","approve","return","reject","withdraw"].includes(input.operation)
      || (input.reason !== undefined && (typeof input.reason !== "string" || input.reason.length>4000))) return failure({code:"22023"});
    let payload = null;
    if (["save","submit"].includes(input.operation)) {
      try { payload = validateRequestPayload(input.payload,input.operation === "submit"); } catch { return failure({code:"22023"}); }
    }
    if (["return","reject"].includes(input.operation) && !input.reason?.trim()) return failure({code:"22023"});
    if (input.evidence !== undefined && (!Array.isArray(input.evidence) || input.evidence.length>3 || JSON.stringify(input.evidence).length>700000 || input.evidence.some(e=>!e || typeof e.name !== "string" || typeof e.base64 !== "string" || !["application/pdf","image/png","image/jpeg"].includes(e.mime)))) return failure({code:"22023"});
    let finance = null;
    if (input.finance !== undefined) {
      if (!["approve","return","reject"].includes(input.operation)) return failure({code:"22023"});
      try { finance = validateRequestFinance(input.finance,input.operation); } catch { return failure({code:"22023"}); }
    }
    dispatched = true;
    const { data, error } = finance
      ? await supabase.rpc("subscription_request_decide_v3", { p_id:input.id, p_version:input.version, p_operation:input.operation, p_reason:input.reason ?? "", p_finance:finance })
      : await supabase.rpc("sr_mutate", { p_id:input.id, p_version:input.version, p_operation:input.operation, p_payload:payload, p_reason:input.reason ?? "", p_evidence:input.evidence ?? null });
    if (error) return failure(error,true);
    if (!validRequest(data)) return failure(null,true);
    if (input.operation === "submit") after(() => dispatchSubscriptionRequestMail(data.id).then(() => undefined));
    return { ok:true, data, committed:true };
  } catch (error) { return failure(error,dispatched); }
}
export async function completeSubscriptionRequestPurchase(id: string, version: number): Promise<RequestResult<SubscriptionRequest>> {
  let dispatched = false;
  try {
    const supabase = await client();
    if (!UUID.test(id) || !Number.isSafeInteger(version) || version < 1) return failure({code:"22023"});
    dispatched = true;
    const {data,error} = await supabase.rpc("subscription_request_complete_purchase_v3", {p_id:id,p_version:version});
    if (error) return failure(error,true);
    if (!validRequest(data) || !data.completedAt || data.canCompletePurchase !== false || data.linkedSubscriptionId) return failure(null,true);
    return {ok:true,data,committed:true};
  } catch(error) { return failure(error,dispatched); }
}
export async function downloadRequestEvidence(id: string, version: number, index: number): Promise<RequestResult<RequestEvidence>> {
  try {
    const supabase = await client();
    if (!UUID.test(id) || !Number.isSafeInteger(version) || version<1 || !Number.isSafeInteger(index) || index<0 || index>2) return failure({code:"22023"});
    const { data, error } = await supabase.rpc("sr_download", {p_id:id,p_version:version,p_index:index});
    if (error) return failure(error);
    if (!data || typeof data.name !== "string" || typeof data.base64 !== "string" || !["application/pdf","image/png","image/jpeg"].includes(data.mime)) return failure(null);
    return {ok:true,data};
  } catch(error) { return failure(error); }
}
