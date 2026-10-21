import { LeaveDemo } from "@/components/leave-demo";
import { RolePermissionRecovery } from "@/components/role-permission-recovery";
import { parsePortalRoleCapabilities, ROLE_CAPABILITY_ERROR, type PortalRoleCapabilities } from "@/lib/portal-role-capabilities";
import { getCheckInResourceLinks } from "@/lib/check-in-register";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
export default async function Home({ searchParams }: { searchParams: SearchParams }) {
  if (!isSupabaseConfigured()) return <RolePermissionRecovery />;
  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) redirect("/login");
  let actor: PortalRoleCapabilities;
  let canViewSubscriptionReviewCalendar = false;
  try {
    const [roleResult, reviewResult] = await Promise.all([
      supabase.rpc("get_portal_role_capabilities", { p_person_id: null }),
      supabase.rpc("can_view_subscription_review_calendar"),
    ]);
    if (roleResult.error || roleResult.status >= 500) throw new Error(ROLE_CAPABILITY_ERROR);
    actor = parsePortalRoleCapabilities(roleResult.data);
    canViewSubscriptionReviewCalendar = !reviewResult.error && !(reviewResult.status >= 500) && reviewResult.data === true;
  } catch {
    return <RolePermissionRecovery />;
  }
  const params = await searchParams;
  const view = firstValue(params.view);
  const section = firstValue(params.section);
  const peopleSection = firstValue(params.tab);
  const requestedView = view === "about" ? "people"
    : view === "leave" || view === "calendar" || view === "people" ? view : "home";
  return <LeaveDemo
    key={`${userData.user.id}:${JSON.stringify(actor)}`}
    authActorId={userData.user.id}
    performanceReviewEnabled={process.env.MAM_PERFORMANCE_REVIEW_ENABLED === "true" && process.env.PERFORMANCE_REVIEW_RELEASE_PAUSED !== "true"}
    actorCapabilities={actor}
    currentPersonId={actor.person_id ?? undefined}
    isNonRosterSystemAdmin={actor.is_super_admin && !actor.person_id}
    canAccessOwnSubscriptions={Boolean(actor.person_id)}
    canViewOwnTasks={Boolean(actor.person_id)}
    canViewTeamCalendar={Boolean(actor.person_id) || actor.is_super_admin}
    canViewSubscriptionReviewCalendar={canViewSubscriptionReviewCalendar}
    checkInResources={actor.can_view_check_in_workspace ? {
      ...getCheckInResourceLinks(),
      canApproveEmploymentDecisions: actor.can_approve_employment_decisions,
    } : undefined}
    initialNavigation={{
      view: requestedView,
      section: section === "approvals" || section === "balance" ? section : "requests",
      requestId: firstValue(params.request),
      peopleSection: peopleSection === "assets" || peopleSection === "accounts" || peopleSection === "subscriptions" || peopleSection === "tasks" || peopleSection === "performance" ? peopleSection : undefined,
    }}
  />;
}
