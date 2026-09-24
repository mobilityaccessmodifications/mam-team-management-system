import { LeaveDemo } from "@/components/leave-demo";
import { getCheckInResourceLinks } from "@/lib/check-in-register";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function Home({ searchParams }: { searchParams: SearchParams }) {
  let isAdmin = false;
  let currentPersonId: string | undefined;
  let isNonRosterSystemAdmin = false;
  let canViewCheckIns = false;
  let canViewEmployeeDirectory = false;
  let canViewOrganisation = false;
  let canChangeEmployeeView = false;
  let canViewSubscriptions = false;
  let canManageSubscriptions = false;
  let canManageSubscriptionCredentials = false;
  let canManageSubscriptionCredentialGrants = false;
  let canManageAnalyticsApi = false;
  let canAccessOwnSubscriptions = false;
  let canViewSubscriptionReviewCalendar = false;
  let canViewOwnTasks = false;
  let checkInResources: ReturnType<typeof getCheckInResourceLinks> | undefined;
  if (isSupabaseConfigured()) {
    const supabase = await createClient();
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) redirect("/login");

    // Keep the established, production-backed capability projection as the
    // login gate. Subscription review visibility is an optional feature
    // capability: if its forward migration is unavailable, the feature stays
    // hidden without turning a valid employee session into a sign-out loop.
    const [
      { data: capabilities, error: capabilitiesError },
      { data: subscriptionReviewCapability, error: subscriptionReviewCapabilityError },
      { data: subscriptionCredentialCapability, error: subscriptionCredentialCapabilityError },
      { data: subscriptionCredentialGrantCapability, error: subscriptionCredentialGrantCapabilityError },
      { data: analyticsApiCapability, error: analyticsApiCapabilityError },
      { data: subscriptionManagementCapability, error: subscriptionManagementCapabilityError },
      { data: employmentDecisionApprovalCapability, error: employmentDecisionApprovalCapabilityError },
    ] = await Promise.all([
      supabase.rpc("get_portal_workspace_capabilities"),
      supabase.rpc("can_view_subscription_review_calendar"),
      // These two capabilities are intentionally independent from the core
      // workspace DTO. If the vault migration is not present yet, credentials
      // remain hidden without interrupting a valid staff session.
      supabase.rpc("can_manage_subscription_credentials"),
      supabase.rpc("can_manage_subscription_credential_grants"),
      // Analytics key lifecycle is intentionally a separate System Admin
      // capability. If its forward migration is unavailable, keep the tab
      // hidden without disrupting an otherwise valid portal session.
      supabase.rpc("can_manage_analytics_api"),
      supabase.rpc("can_manage_subscriptions"),
      supabase.rpc("can_approve_employee_check_in_employment_decision"),
    ]);
    const current = Array.isArray(capabilities) ? capabilities[0] : null;
    isAdmin = current?.can_manage_accounts === true;
    currentPersonId = current?.person_id ?? undefined;
    isNonRosterSystemAdmin = current?.can_access_non_roster_system_admin_workspace === true;
    canViewCheckIns = current?.can_view_check_in_workspace === true;
    canViewEmployeeDirectory = current?.can_view_employee_directory === true;
    canViewOrganisation = current?.can_view_organisation_chart === true;
    checkInResources = canViewCheckIns ? {
      ...getCheckInResourceLinks(),
      canApproveEmploymentDecisions: !employmentDecisionApprovalCapabilityError && employmentDecisionApprovalCapability === true,
    } : undefined;
    canChangeEmployeeView = current?.can_change_employee_view === true;
    canViewSubscriptions = current?.can_view_subscription_register === true;
    canManageSubscriptions = !subscriptionManagementCapabilityError && subscriptionManagementCapability === true;
    canManageSubscriptionCredentials = !subscriptionCredentialCapabilityError
      && subscriptionCredentialCapability === true;
    canManageSubscriptionCredentialGrants = !subscriptionCredentialGrantCapabilityError
      && subscriptionCredentialGrantCapability === true;
    canManageAnalyticsApi = !analyticsApiCapabilityError && analyticsApiCapability === true;
    canAccessOwnSubscriptions = current?.can_access_own_subscriptions === true;
    canViewSubscriptionReviewCalendar = !subscriptionReviewCapabilityError
      && subscriptionReviewCapability === true;
    // Every active linked employee may open their own task surface. Its
    // contents remain limited by the dedicated task data source; this flag
    // only controls whether the tab itself is available.
    canViewOwnTasks = Boolean(currentPersonId);
    if (
      capabilitiesError
      || (
        !isNonRosterSystemAdmin
        && (!current || current.account_status !== "active" || !currentPersonId)
      )
    ) {
      await supabase.auth.signOut({ scope: "local" });
      redirect("/login");
    }
  }

  const params = await searchParams;
  const view = firstValue(params.view);
  const section = firstValue(params.section);
  const peopleSection = firstValue(params.tab);
  const requestId = firstValue(params.request);
  // Preserve previously shared About-me demo links by opening the merged People profile view.
  const requestedView = view === "about"
    ? "people"
    : view === "leave" || view === "calendar" || view === "people" ? view : "home";
  // Calendar is a core employee workspace. Its database projections decide
  // which records are relevant: ordinary employees receive only their own
  // leave and Check-ins plus birthdays, while explicit approved-leave viewers
  // and System Admin receive their separately authorised additions.
  const canViewTeamCalendar = Boolean(currentPersonId) || isNonRosterSystemAdmin;
  const resolvedView = requestedView === "calendar" && !(canViewTeamCalendar || canViewSubscriptionReviewCalendar)
    ? "home"
    : requestedView;

  return <LeaveDemo
    isAdmin={isAdmin}
    currentPersonId={currentPersonId}
    isNonRosterSystemAdmin={isNonRosterSystemAdmin}
    canViewEmployeeDirectory={canViewEmployeeDirectory}
    canViewOrganisation={canViewOrganisation}
    canChangeEmployeeView={canChangeEmployeeView}
    canViewSubscriptions={canViewSubscriptions}
    canManageSubscriptions={canManageSubscriptions}
    canManageSubscriptionCredentials={canManageSubscriptionCredentials}
    canManageSubscriptionCredentialGrants={canManageSubscriptionCredentialGrants}
    canManageAnalyticsApi={canManageAnalyticsApi}
    canAccessOwnSubscriptions={canAccessOwnSubscriptions}
    canViewSubscriptionReviewCalendar={canViewSubscriptionReviewCalendar}
    canViewOwnTasks={canViewOwnTasks}
    canViewTeamCalendar={canViewTeamCalendar}
    checkInResources={checkInResources}
    initialNavigation={{
    view: resolvedView,
    section: section === "approvals" || section === "balance" ? section : "requests",
    requestId,
    peopleSection: peopleSection === "assets" || peopleSection === "accounts" || peopleSection === "subscriptions" ? peopleSection : undefined,
  }}
  />;
}
