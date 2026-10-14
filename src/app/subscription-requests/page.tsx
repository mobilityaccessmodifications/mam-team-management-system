import Link from "next/link";
import { loadSubscriptionRequests } from "./actions";
import { SubscriptionRequests } from "@/components/subscription-requests";
import { UUID } from "@/lib/subscription-request-types";

export default async function SubscriptionRequestsPage({ searchParams }: { searchParams: Promise<{ request?: string; new?: string }> }) {
  const [result, params] = await Promise.all([loadSubscriptionRequests(), searchParams]);
  return <main data-company="mam"><nav aria-label="Subscriptions"><Link href="/?view=people&tab=subscriptions" prefetch={false}>Register</Link> <span aria-current="page">Requests</span></nav>{result.ok?<SubscriptionRequests initial={result.data} startNew={params.new === "1"} selectedId={params.request && UUID.test(params.request)?params.request:undefined}/>:<p role="alert">{result.message}</p>}</main>;
}
