import "server-only";
import { isAuthSessionMissingError } from "@supabase/supabase-js";
import { parsePortalRoleCapabilities, ROLE_CAPABILITY_ERROR } from "@/lib/portal-role-capabilities";
import { createClient } from "@/lib/supabase/server";

export class PerformanceReviewAccessError extends Error {
  constructor(readonly code: "unauthenticated" | "forbidden") {
    super("Performance review access is not available.");
  }
}

export async function requirePerformanceReviewActor() {
  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (!userError && !userData.user) throw new PerformanceReviewAccessError("unauthenticated");
  if (userError) {
    if (isAuthSessionMissingError(userError) || userError.status === 401 || userError.status === 403) throw new PerformanceReviewAccessError("unauthenticated");
    throw new Error(ROLE_CAPABILITY_ERROR);
  }
  if (!userData.user) throw new Error(ROLE_CAPABILITY_ERROR);
  const { data, error, status } = await supabase.rpc("get_portal_role_capabilities", { p_person_id: null });
  if (error || status >= 500) {
    if (status === 401) throw new PerformanceReviewAccessError("unauthenticated");
    if (!(status >= 500) && error?.code === "42501") throw new PerformanceReviewAccessError("forbidden");
    throw new Error(ROLE_CAPABILITY_ERROR);
  }
  return { supabase, actorUserId: userData.user.id, capabilities: parsePortalRoleCapabilities(data) };
}

export async function requirePerformanceReviewViewer(previewPersonId?: string) {
  const actor = await requirePerformanceReviewActor();
  if (previewPersonId === undefined) return actor;
  if (actor.capabilities.app_role !== "system_admin" || !actor.capabilities.is_super_admin || !actor.capabilities.can_change_employee_view) throw new PerformanceReviewAccessError("forbidden");
  const { data, error, status } = await actor.supabase.rpc("get_portal_role_capabilities", { p_person_id: previewPersonId });
  if (error || status >= 500) {
    if (status === 401) throw new PerformanceReviewAccessError("unauthenticated");
    if (!(status >= 500) && error?.code === "42501") throw new PerformanceReviewAccessError("forbidden");
    throw new Error(ROLE_CAPABILITY_ERROR);
  }
  return { ...actor, capabilities: parsePortalRoleCapabilities(data, previewPersonId) };
}
