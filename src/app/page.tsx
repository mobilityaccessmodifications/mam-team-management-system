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
  let canChangeEmployeeView = false;
  let canViewOwnTasks = false;
  let checkInResources: ReturnType<typeof getCheckInResourceLinks> | undefined;
  if (isSupabaseConfigured()) {
    const supabase = await createClient();
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) redirect("/login");

    const [
      { data: canManageAccounts },
      { data: account, error: accountError },
      { data: canAccessNonRosterSystemAdminWorkspace },
      { data: canViewCheckInWorkspace },
      { data: canViewEmployeeDirectoryCapability },
      { data: canChangeEmployeeViewCapability },
    ] = await Promise.all([
      supabase.rpc("can_manage_portal_accounts"),
      supabase.rpc("current_portal_account"),
      supabase.rpc("can_access_non_roster_system_admin_workspace"),
      supabase.rpc("can_view_employee_check_in_workspace"),
      supabase.rpc("can_view_employee_directory"),
      supabase.rpc("can_change_employee_view"),
    ]);
    const current = Array.isArray(account) ? account[0] : null;
    isAdmin = canManageAccounts === true;
    currentPersonId = current?.person_id ?? undefined;
    isNonRosterSystemAdmin = canAccessNonRosterSystemAdminWorkspace === true;
    canViewCheckIns = canViewCheckInWorkspace === true;
    canViewEmployeeDirectory = canViewEmployeeDirectoryCapability === true;
    checkInResources = canViewCheckIns ? getCheckInResourceLinks() : undefined;
    canChangeEmployeeView = canChangeEmployeeViewCapability === true;
    // Every active linked employee may open their own task surface. Its
    // contents remain limited by the dedicated task data source; this flag
    // only controls whether the tab itself is available.
    canViewOwnTasks = Boolean(currentPersonId);
    if (
      accountError
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
  const requestId = firstValue(params.request);
  // Preserve previously shared About-me demo links by opening the merged People profile view.
  const requestedView = view === "about"
    ? "people"
    : view === "leave" || view === "calendar" || view === "people" ? view : "home";
  // The team calendar is a manager/System Admin workspace. Resolve unauthorised
  // deep links on the server so an employee never lands on its client view.
  const canViewTeamCalendar = isAdmin || canViewCheckIns;
  const resolvedView = requestedView === "calendar" && !canViewTeamCalendar
    ? "home"
    : requestedView;

  return <LeaveDemo
    isAdmin={isAdmin}
    currentPersonId={currentPersonId}
    isNonRosterSystemAdmin={isNonRosterSystemAdmin}
    canViewEmployeeDirectory={canViewEmployeeDirectory}
    canChangeEmployeeView={canChangeEmployeeView}
    canViewOwnTasks={canViewOwnTasks}
    canViewTeamCalendar={canViewTeamCalendar}
    checkInResources={checkInResources}
    initialNavigation={{
    view: resolvedView,
    section: section === "approvals" ? "approvals" : "requests",
    requestId,
  }}
  />;
}
