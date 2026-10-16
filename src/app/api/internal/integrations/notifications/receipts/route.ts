import { isUatMode } from "@/lib/uat-safety";
import { handleNotificationReceipts, type ReceiptRpc } from "@/lib/notification-receipts";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 15;

function handle(request: Request) {
  if (isUatMode()) return Response.json({ error: "This operation is unavailable in UAT." }, { status: 403 });
  // Construct the privileged client only after the handler checks the existing
  // notification integration credential and the complete bounded request.
  const rpc: ReceiptRpc = async (name, args) => createAdminClient().rpc(name, args).abortSignal(AbortSignal.timeout(8000));
  return handleNotificationReceipts(request, process.env.MAM_N8N_LEAVE_WEBHOOK_SECRET, rpc);
}

export const GET = handle;
export const POST = handle;
