"use server";

import { dispatchPerformanceReviewNotificationsForReview } from "@/lib/performance-review-notifications";
import { after } from "next/server";
import { dispatchPerformanceReviewMailForReview } from "@/lib/performance-review-mail";

import type { PerformanceFailure, PerformanceLoadResult, PerformanceStartInput, PerformanceStartResult, PerformanceMutationInput, PerformanceMutationResult, PerformanceReconcileInput, PerformanceReconcileResult, PerformanceDocumentResult } from "@/lib/performance-review-types";
import { PerformanceReviewAccessError, requirePerformanceReviewActor, requirePerformanceReviewViewer, requirePerformanceReviewManagerDelegate } from "@/lib/performance-review-auth";
import { closed, uuid, parseDocument, parseReconcileInput, parseMutationInput, parseStartInput, parseReview, parseWorkspace } from "@/lib/performance-review-rules";
function failure(code: PerformanceFailure["code"]): PerformanceFailure {
  return { ok: false, code, uncertain: code === "uncertain", message: ({ invalid: "Check the review fields.", forbidden: "You do not have access to this review.", unauthenticated: "Sign in before using performance reviews.", conflict: "The review has changed. Reload or reconcile before continuing.", unavailable: "Performance reviews are not available.", uncertain: "The result is unknown. Reconcile this operation before another write." })[code] };
}
function rpcFailure(error: { code?: string }, mutation: boolean, status?: number): PerformanceFailure {
  if (!(status && status >= 500)) {
    if (error.code === "42501") return failure("forbidden");
    if (error.code === "22023") return failure("invalid");
    if (error.code === "PT409") return failure("conflict");
    if (error.code === "PGRST301" || error.code === "PGRST302") return failure("unauthenticated");
  }
  return failure(mutation ? "uncertain" : "unavailable");
}
function reviewScope(review: { audience: string; employee: { id: string }; manager: { id: string } }, role: string, personId: string | null): boolean {
  if (role === "admin" || role === "system_admin") return review.audience === "admin";
  if (review.employee.id === personId) return review.audience === "employee";
  return role === "manager" && review.audience === "manager" && review.manager.id === personId;
}
function schedulePerformanceReviewMail(reviewId: string): void {
  try {
    after(async () => {
      try { await dispatchPerformanceReviewMailForReview(reviewId); }
      catch { return; }
    });
  } catch { return; }
}
function schedulePerformanceReviewNotification(reviewId: string): void {
  try { after(() => dispatchPerformanceReviewNotificationsForReview(reviewId)); } catch { return; }
}
function disabled(): PerformanceFailure { return { ok: false, code: "unavailable", uncertain: false, message: "Performance reviews are not available." }; }
export async function loadPerformanceReviews(previewPersonId?: string): Promise<PerformanceLoadResult> {
  if (process.env.MAM_PERFORMANCE_REVIEW_ENABLED !== "true") return disabled();
  try { if (previewPersonId !== undefined) uuid(previewPersonId); } catch { return failure("invalid"); }
  try {
    const { supabase, actorUserId, capabilities } = await requirePerformanceReviewViewer(previewPersonId);
    const { data, error, status } = previewPersonId === undefined
      ? await supabase.rpc("performance_review_workspace")
      : await supabase.rpc(capabilities.app_role === "manager" ? "performance_review_workspace_for_delegate" : "performance_review_workspace_for_preview", { p_person_id: previewPersonId });
    if (status >= 500) return failure("unavailable");
    if (error) return rpcFailure(error, false, status);
    return { ok: true, data: parseWorkspace(data, actorUserId, capabilities.app_role, capabilities.person_id, previewPersonId === undefined ? false : capabilities.app_role === "manager" ? "manager_delegate" : true) };
  } catch (error) { return error instanceof PerformanceReviewAccessError ? failure(error.code) : disabled(); }
}
export async function startPerformanceReview(input: PerformanceStartInput, previewPersonId?: string): Promise<PerformanceStartResult> {
  if (process.env.MAM_PERFORMANCE_REVIEW_ENABLED !== "true") return disabled();
  let request: PerformanceStartInput;
  try { request = parseStartInput(input); if (previewPersonId !== undefined) uuid(previewPersonId); } catch { return failure("invalid"); }
  let dispatched = false;
  try {
    const { supabase, capabilities } = previewPersonId === undefined ? await requirePerformanceReviewActor() : await requirePerformanceReviewManagerDelegate(previewPersonId);
    if (capabilities.app_role !== "manager") return failure("forbidden");
    dispatched = true;
    const args = { p_operation_id: request.operationId, p_employee_person_id: request.employeePersonId, p_cycle: request.cycle, p_due_date: request.dueDate };
    const { data, error, status } = previewPersonId === undefined
      ? await supabase.rpc("start_performance_review", args)
      : await supabase.rpc("start_performance_review_for_delegate", { p_person_id: previewPersonId, ...args });
    if (status >= 500) return failure("uncertain");
    if (error) return rpcFailure(error, true, status);
    const receipt = closed(data, ["committed", "operationId", "review", "existing"]);
    const review = parseReview(receipt.review);
    if (receipt.committed !== true || receipt.operationId !== request.operationId || typeof receipt.existing !== "boolean" || review.audience !== "manager" || review.manager.id !== capabilities.person_id || review.employee.id !== request.employeePersonId || review.cycle !== request.cycle || (!receipt.existing && review.dueDate !== request.dueDate)) return failure("uncertain");
    if (!receipt.existing) schedulePerformanceReviewNotification(review.id);
    return { ok: true, committed: true, operationId: request.operationId, review, existing: receipt.existing };
  } catch (error) { return failure(!dispatched && error instanceof PerformanceReviewAccessError ? error.code : dispatched ? "uncertain" : "unavailable"); }
}
export async function mutatePerformanceReview(input: PerformanceMutationInput, previewPersonId?: string): Promise<PerformanceMutationResult> {
  if (process.env.MAM_PERFORMANCE_REVIEW_ENABLED !== "true") return disabled();
  let request: PerformanceMutationInput;
  try { request = parseMutationInput(input); if (previewPersonId !== undefined) uuid(previewPersonId); } catch { return failure("invalid"); }
  let dispatched = false;
  try {
    const { supabase, capabilities } = previewPersonId === undefined ? await requirePerformanceReviewActor() : await requirePerformanceReviewManagerDelegate(previewPersonId);
    if (previewPersonId !== undefined && (request.command === "save_self" || request.command === "submit_self")) return failure("forbidden");
    if (["admin", "system_admin"].includes(capabilities.app_role)) return failure("forbidden");
    if (request.command !== "save_self" && request.command !== "submit_self" && capabilities.app_role !== "manager") return failure("forbidden");
    dispatched = true;
    const args = { p_operation_id: request.operationId, p_review_id: request.reviewId, p_expected_revision: request.expectedRevision, p_command: request.command, p_input: request.input };
    const { data, error, status } = previewPersonId === undefined
      ? await supabase.rpc("mutate_performance_review", args)
      : await supabase.rpc("mutate_performance_review_for_delegate", { p_person_id: previewPersonId, ...args });
    if (status >= 500) return failure("uncertain");
    if (error) return rpcFailure(error, true, status);
    const receipt = closed(data, ["committed", "operationId", "review"]);
    const review = parseReview(receipt.review);
    const self = request.command === "save_self" || request.command === "submit_self";
    if (receipt.committed !== true || receipt.operationId !== request.operationId || review.id !== request.reviewId || (self ? review.audience !== "employee" || review.employee.id !== capabilities.person_id : review.audience !== "manager" || review.manager.id !== capabilities.person_id)) return failure("uncertain");
    if (request.command === "submit_self") schedulePerformanceReviewNotification(review.id);
    if (request.command === "submit_review") schedulePerformanceReviewMail(review.id);
    return { ok: true, committed: true, operationId: request.operationId, review };
  } catch (error) { return failure(!dispatched && error instanceof PerformanceReviewAccessError ? error.code : dispatched ? "uncertain" : "unavailable"); }
}
export async function reconcilePerformanceReviewOperation(input: PerformanceReconcileInput, previewPersonId?: string): Promise<PerformanceReconcileResult> {
  if (process.env.MAM_PERFORMANCE_REVIEW_ENABLED !== "true") return disabled();
  let request: PerformanceReconcileInput;
  try { request = parseReconcileInput(input); if (previewPersonId !== undefined) uuid(previewPersonId); } catch { return failure("invalid"); }
  try {
    const { supabase, capabilities } = previewPersonId === undefined ? await requirePerformanceReviewActor() : await requirePerformanceReviewManagerDelegate(previewPersonId);
    const args = { p_operation_id: request.operationId, p_review_id: request.reviewId };
    const { data, error, status } = previewPersonId === undefined
      ? await supabase.rpc("get_performance_review_operation", args)
      : await supabase.rpc("get_performance_review_operation_for_delegate", { p_person_id: previewPersonId, ...args });
    if (status >= 500) return failure("unavailable");
    if (error) return rpcFailure(error, false, status);
    const receipt = closed(data, ["status", "review"]);
    if (receipt.status === "not_found" && receipt.review === null) return { ok: true, data: { status: "not_found", review: null } };
    if (receipt.status !== "committed") return failure("unavailable");
    const review = parseReview(receipt.review);
    if ((request.reviewId !== null && review.id !== request.reviewId) || !reviewScope(review, capabilities.app_role, capabilities.person_id) || (previewPersonId !== undefined && review.audience !== "manager")) return failure("unavailable");
    return { ok: true, data: { status: "committed", review } };
  } catch (error) { return failure(error instanceof PerformanceReviewAccessError ? error.code : "unavailable"); }
}
export async function getPerformanceReviewDocument(reviewId: string, previewPersonId?: string): Promise<PerformanceDocumentResult> {
  if (process.env.MAM_PERFORMANCE_REVIEW_ENABLED !== "true") return disabled();
  try { uuid(reviewId); if (previewPersonId !== undefined) uuid(previewPersonId); } catch { return failure("invalid"); }
  try {
    const { supabase, capabilities } = await requirePerformanceReviewViewer(previewPersonId);
    const { data, error, status } = previewPersonId === undefined
      ? await supabase.rpc("get_performance_review_document", { p_review_id: reviewId })
      : await supabase.rpc("get_performance_review_document_for_preview", { p_person_id: previewPersonId, p_review_id: reviewId });
    if (status >= 500) return failure("unavailable");
    if (error) return rpcFailure(error, false, status);
    const document = parseDocument(data);
    if (!reviewScope(document, capabilities.app_role, capabilities.person_id)) return failure("unavailable");
    return { ok: true, document };
  } catch (error) { return failure(error instanceof PerformanceReviewAccessError ? error.code : "unavailable"); }
}
