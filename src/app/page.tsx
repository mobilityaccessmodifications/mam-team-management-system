import { LeaveDemo } from "@/components/leave-demo";
import { RolePermissionRecovery } from "@/components/role-permission-recovery";
import { getPortalRoleCapabilities } from "@/app/roles/actions";
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
  const result = await getPortalRoleCapabilities();
  if (!result.ok) return <RolePermissionRecovery />;
  const actor = result.capabilities;
  const { data: reviewCapability, error: reviewError } = await supabase.rpc("can_view_subscription_review_calendar");
  const params = await searchParams;
  const view = firstValue(params.view);
  const section = firstValue(params.section);
  const peopleSection = firstValue(params.tab);
  const requestedView = view === "about" ? "people"
    : view === "leave" || view === "calendar" || view === "people" ? view : "home";
  return <LeaveDemo
    key={JSON.stringify(actor)}
    actorCapabilities={actor}
    currentPersonId={actor.person_id ?? undefined}
    isNonRosterSystemAdmin={actor.is_super_admin && !actor.person_id}
    canAccessOwnSubscriptions={Boolean(actor.person_id)}
    canViewOwnTasks={Boolean(actor.person_id)}
    canViewTeamCalendar={Boolean(actor.person_id) || actor.is_super_admin}
    canViewSubscriptionReviewCalendar={!reviewError && reviewCapability === true}
    checkInResources={actor.can_view_check_in_workspace ? {
      ...getCheckInResourceLinks(),
      canApproveEmploymentDecisions: actor.can_approve_employment_decisions,
    } : undefined}
    initialNavigation={{
      view: requestedView,
      section: section === "approvals" || section === "balance" ? section : "requests",
      requestId: firstValue(params.request),
      peopleSection: peopleSection === "assets" || peopleSection === "accounts" || peopleSection === "subscriptions" || peopleSection === "tasks" ? peopleSection : undefined,
    }}
  />;
}
