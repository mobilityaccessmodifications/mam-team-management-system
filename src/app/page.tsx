import { LeaveDemo } from "@/components/leave-demo";
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
  if (isSupabaseConfigured()) {
    const supabase = await createClient();
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) redirect("/login");

    const [{ data: canManageAccounts }, { data: account, error: accountError }] = await Promise.all([
      supabase.rpc("can_manage_portal_accounts"),
      supabase.rpc("current_portal_account"),
    ]);
    const current = Array.isArray(account) ? account[0] : null;
    isAdmin = canManageAccounts === true;
    currentPersonId = current?.person_id ?? undefined;
    if (accountError || !current || current.account_status !== "active" || !currentPersonId) {
      await supabase.auth.signOut({ scope: "local" });
      redirect("/login");
    }
  }

  const params = await searchParams;
  const view = firstValue(params.view);
  const section = firstValue(params.section);
  const requestId = firstValue(params.request);
  // Preserve previously shared About-me demo links by opening the merged People profile view.
  const resolvedView = view === "about"
    ? "people"
    : view === "leave" || view === "people" ? view : "home";

  return <LeaveDemo isAdmin={isAdmin} currentPersonId={currentPersonId} initialNavigation={{
    view: resolvedView,
    section: section === "approvals" ? "approvals" : "requests",
    requestId,
  }} />;
}
