"use server";

import type { PerformanceFailure, PerformanceLoadResult, PerformanceStartInput, PerformanceStartResult, PerformanceMutationInput, PerformanceMutationResult, PerformanceReconcileInput, PerformanceReconcileResult, PerformanceDocumentResult } from "@/lib/performance-review-types";
import { PerformanceReviewAccessError, requirePerformanceReviewActor } from "@/lib/performance-review-auth";
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
function disabled(): PerformanceFailure { return { ok: false, code: "unavailable", uncertain: false, message: "Performance reviews are not available." }; }
export async function loadPerformanceReviews(): Promise<PerformanceLoadResult> {
  if (process.env.MAM_PERFORMANCE_REVIEW_ENABLED !== "true") return disabled();
  try {
    const { supabase, actorUserId, capabilities } = await requirePerformanceReviewActor();
    const { data, error, status } = await supabase.rpc("performance_review_workspace");
    if (status >= 500) return failure("unavailable");
    if (error) return rpcFailure(error, false, status);
    return { ok: true, data: parseWorkspace(data, actorUserId, capabilities.app_role, capabilities.person_id) };
  } catch (error) { return error instanceof PerformanceReviewAccessError ? failure(error.code) : disabled(); }
}
export async function startPerformanceReview(input: PerformanceStartInput): Promise<PerformanceStartResult> {
  if (process.env.MAM_PERFORMANCE_REVIEW_ENABLED !== "true") return disabled();
  let request: PerformanceStartInput;
  try { request = parseStartInput(input); } catch { return failure("invalid"); }
  let dispatched = false;
  try {
    const { supabase, capabilities } = await requirePerformanceReviewActor();
    if (capabilities.app_role !== "manager") return failure("forbidden");
    dispatched = true;
    const { data, error, status } = await supabase.rpc("start_performance_review", { p_operation_id: request.operationId, p_employee_person_id: request.employeePersonId, p_cycle: request.cycle, p_due_date: request.dueDate });
    if (status >= 500) return failure("uncertain");
    if (error) return rpcFailure(error, true, status);
    const receipt = closed(data, ["committed", "operationId", "review", "existing"]);
    const review = parseReview(receipt.review);
    if (receipt.committed !== true || receipt.operationId !== request.operationId || typeof receipt.existing !== "boolean" || review.audience !== "manager" || review.manager.id !== capabilities.person_id || review.employee.id !== request.employeePersonId || review.cycle !== request.cycle || (!receipt.existing && review.dueDate !== request.dueDate)) return failure("uncertain");
    return { ok: true, committed: true, operationId: request.operationId, review, existing: receipt.existing };
  } catch (error) { return failure(!dispatched && error instanceof PerformanceReviewAccessError ? error.code : dispatched ? "uncertain" : "unavailable"); }
}
export async function mutatePerformanceReview(input: PerformanceMutationInput): Promise<PerformanceMutationResult> {
  if (process.env.MAM_PERFORMANCE_REVIEW_ENABLED !== "true") return disabled();
  let request: PerformanceMutationInput;
  try { request = parseMutationInput(input); } catch { return failure("invalid"); }
  let dispatched = false;
  try {
    const { supabase, capabilities } = await requirePerformanceReviewActor();
    if (["admin", "system_admin"].includes(capabilities.app_role)) return failure("forbidden");
    if (request.command !== "save_self" && request.command !== "submit_self" && capabilities.app_role !== "manager") return failure("forbidden");
    dispatched = true;
    const { data, error, status } = await supabase.rpc("mutate_performance_review", { p_operation_id: request.operationId, p_review_id: request.reviewId, p_expected_revision: request.expectedRevision, p_command: request.command, p_input: request.input });
    if (status >= 500) return failure("uncertain");
    if (error) return rpcFailure(error, true, status);
    const receipt = closed(data, ["committed", "operationId", "review"]);
    const review = parseReview(receipt.review);
    const self = request.command === "save_self" || request.command === "submit_self";
    if (receipt.committed !== true || receipt.operationId !== request.operationId || review.id !== request.reviewId || (self ? review.audience !== "employee" || review.employee.id !== capabilities.person_id : review.audience !== "manager" || review.manager.id !== capabilities.person_id)) return failure("uncertain");
    return { ok: true, committed: true, operationId: request.operationId, review };
  } catch (error) { return failure(!dispatched && error instanceof PerformanceReviewAccessError ? error.code : dispatched ? "uncertain" : "unavailable"); }
}
export async function reconcilePerformanceReviewOperation(input: PerformanceReconcileInput): Promise<PerformanceReconcileResult> {
  if (process.env.MAM_PERFORMANCE_REVIEW_ENABLED !== "true") return disabled();
  let request: PerformanceReconcileInput;
  try { request = parseReconcileInput(input); } catch { return failure("invalid"); }
  try {
    const { supabase, capabilities } = await requirePerformanceReviewActor();
    const { data, error, status } = await supabase.rpc("get_performance_review_operation", { p_operation_id: request.operationId, p_review_id: request.reviewId });
    if (status >= 500) return failure("unavailable");
    if (error) return rpcFailure(error, false, status);
    const receipt = closed(data, ["status", "review"]);
    if (receipt.status === "not_found" && receipt.review === null) return { ok: true, data: { status: "not_found", review: null } };
    if (receipt.status !== "committed") return failure("unavailable");
    const review = parseReview(receipt.review);
    if ((request.reviewId !== null && review.id !== request.reviewId) || !reviewScope(review, capabilities.app_role, capabilities.person_id)) return failure("unavailable");
    return { ok: true, data: { status: "committed", review } };
  } catch (error) { return failure(error instanceof PerformanceReviewAccessError ? error.code : "unavailable"); }
}
export async function getPerformanceReviewDocument(reviewId: string): Promise<PerformanceDocumentResult> {
  if (process.env.MAM_PERFORMANCE_REVIEW_ENABLED !== "true") return disabled();
  try { uuid(reviewId); } catch { return failure("invalid"); }
  try {
    const { supabase, capabilities } = await requirePerformanceReviewActor();
    const { data, error, status } = await supabase.rpc("get_performance_review_document", { p_review_id: reviewId });
    if (status >= 500) return failure("unavailable");
    if (error) return rpcFailure(error, false, status);
    const document = parseDocument(data);
    if (!reviewScope(document, capabilities.app_role, capabilities.person_id)) return failure("unavailable");
    return { ok: true, document };
  } catch (error) { return failure(error instanceof PerformanceReviewAccessError ? error.code : "unavailable"); }
}
