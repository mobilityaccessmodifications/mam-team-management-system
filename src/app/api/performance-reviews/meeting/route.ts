import { createAdminClient } from "@/lib/supabase/admin";
import { handlePerformanceMeetingRequest, type MeetingImportRpc } from "@/lib/performance-review-meeting";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

function handle(request: Request) {
  const rpc: MeetingImportRpc = (name, args, signal) => createAdminClient().rpc(name, args).retry(false).abortSignal(signal);
  return handlePerformanceMeetingRequest(request, rpc);
}

export const GET = handle;
export const POST = handle;
