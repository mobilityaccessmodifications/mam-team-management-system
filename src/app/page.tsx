import { LeaveDemo } from "@/components/leave-demo";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function Home({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const view = firstValue(params.view);
  const section = firstValue(params.section);
  const requestId = firstValue(params.request);
  // Preserve previously shared About-me demo links by opening the merged People profile view.
  const resolvedView = view === "about"
    ? "people"
    : view === "leave" || view === "people" ? view : "home";

  return <LeaveDemo initialNavigation={{
    view: resolvedView,
    section: section === "approvals" ? "approvals" : "requests",
    requestId,
  }} />;
}
