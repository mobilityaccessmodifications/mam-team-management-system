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

  return <LeaveDemo initialNavigation={{
    view: view === "leave" || view === "people" || view === "about" ? view : "home",
    section: section === "approvals" ? "approvals" : "requests",
    requestId,
  }} />;
}
