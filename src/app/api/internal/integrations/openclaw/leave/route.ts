import { handleLeaveBridge, LEAVE_BRIDGE_PATH } from "@/lib/openclaw-leave-contract";
import { createLeaveBridgeStore } from "@/lib/openclaw-leave-store";
import { dispatchLeaveNotificationsForRequest } from "@/lib/leave-notification-outbox";
import { after } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Confirmation returns before mail delivery; leave room for both the database
// transaction and the existing bounded notification worker's post-response work.
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store, max-age=0", "X-Content-Type-Options": "nosniff" };
const reply = (code: string, status: number) => Response.json({ code }, { status, headers });

export async function POST(request: Request) {
  // Explicit rollout gate. No credential means no DB access; never reuse the
  // read-only allowlist secret or accept browser/caller-selected identity.
  if (process.env.MAM_OPENCLAW_LEAVE_ENABLED !== "true") return reply("unavailable", 503);
  const key = process.env.MAM_OPENCLAW_LEAVE_BRIDGE_SECRET ?? "";
  const account = process.env.MAM_OPENCLAW_LEAVE_ACCOUNT ?? "";
  if (!key || !account || key === process.env.MAM_OPENCLAW_ALLOWLIST_SECRET || key === process.env.CRON_SECRET) return reply("unavailable", 503);
  const url = new URL(request.url);
  if (url.pathname !== LEAVE_BRIDGE_PATH || url.search || request.headers.has("origin") || request.headers.has("cookie") || request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return reply("invalid_request", 400);
  const timestamp = request.headers.get("x-mam-timestamp") ?? "";
  const signature = request.headers.get("x-mam-signature") ?? "";
  if (!/^\d{13}$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(signature)) return reply("unauthorized", 401);
  if (!request.body) return reply("invalid_request", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) { await reader.cancel(); return reply("invalid_request", 413); }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const result = await handleLeaveBridge(raw, timestamp, signature, { key, account }, createLeaveBridgeStore());
    if (result.status === 200 && result.body.code === "submitted"
      && "status" in result.body && result.body.status === "Pending"
      && "requestId" in result.body && typeof result.body.requestId === "string"
      && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(result.body.requestId)) {
      const requestId = result.body.requestId;
      try {
        // Use the same durable queue as portal submission, including successful
        // confirmation replays. Its claims/event keys prevent duplicate mail.
        // Only a committed, server-owned ID may reach this request-scoped drain.
        after(() => dispatchLeaveNotificationsForRequest(requestId));
      } catch {
        // Submission already committed: a scheduling failure must not tell the
        // employee to create a duplicate. The periodic queue worker can retry.
        console.warn("Leave notification remains queued.");
      }
    }
    return Response.json(result.body, { status: result.status, headers });
  } catch {
    return reply("unavailable", 503);
  } finally { reader.releaseLock(); }
}
