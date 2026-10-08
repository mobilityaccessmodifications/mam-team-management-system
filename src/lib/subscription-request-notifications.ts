import { UUID } from "@/lib/subscription-request-types";

export function requestNotification(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid request notification.");
  const row=input as Record<string,unknown>;
  if (Object.keys(row).sort().join(",") !== "cc_user_ids,event,request_id,to_user_id,version"
    || typeof row.request_id !== "string" || !UUID.test(row.request_id) || typeof row.to_user_id !== "string" || !UUID.test(row.to_user_id)
    || !Number.isSafeInteger(row.version) || (row.version as number)<1 || !Array.isArray(row.cc_user_ids) || row.cc_user_ids.length!==0
    || typeof row.event !== "string" || !["submit","approve","return","reject","withdraw"].includes(row.event)) throw new Error("Invalid request notification.");
  const subjects: Record<string,string>={submit:"Subscription request submitted",approve:"Subscription request approved",return:"Subscription request returned",reject:"Subscription request rejected",withdraw:"Subscription request withdrawn"};
  return { eventKey:`subscription-request:${row.request_id}:${row.version}`, toUserId:row.to_user_id, ccUserIds:[] as string[],
    subject:subjects[row.event], link:`https://mam-team-management-system-ten.vercel.app/subscription-requests?request=${row.request_id}` };
}
