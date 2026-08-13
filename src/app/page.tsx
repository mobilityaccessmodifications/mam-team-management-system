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
  if (isSupabaseConfigured()) {
    const supabase = await createClient();
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) redirect("/login");

    const { data: canEditOrganisation, error: permissionError } = await supabase
      .rpc("can_edit_internal_org");
    isAdmin = !permissionError && canEditOrganisation === true;
    if (!isAdmin) {
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

  return <LeaveDemo isAdmin={isAdmin} initialNavigation={{
    view: resolvedView,
    section: section === "approvals" ? "approvals" : "requests",
    requestId,
  }} />;
}
