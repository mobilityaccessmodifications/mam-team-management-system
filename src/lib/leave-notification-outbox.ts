import "server-only";
import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";

function emailList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[;,]/) : [];
  return [...new Set(values.filter((v): v is string => typeof v === "string")
    .map((v) => v.trim().toLowerCase()).filter((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)))].sort();
}

function bodyNote(value: unknown): string | null {
  // RPCs may receive control characters which textarea users do not normally
  // type. Do not let body-only formatting suppress a durable notification.
  // The original database note/snapshot is unchanged; this is mail rendering.
  return typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim() || null : null;
}

function receiver() {
  const secret = process.env.MAM_N8N_LEAVE_WEBHOOK_SECRET?.trim();
  const url = new URL(process.env.MAM_N8N_LEAVE_WEBHOOK_URL ?? "");
  const origin = new URL(process.env.MAM_N8N_LEAVE_WEBHOOK_ORIGIN ?? "");
  if (!secret || url.protocol !== "https:" || origin.protocol !== "https:" || url.origin !== origin.origin
    || origin.pathname !== "/" || origin.username || origin.password || origin.search || origin.hash
    || url.username || url.password || url.search || url.hash || url.pathname === "/") throw new Error("not_configured");
  return { url, secret };
}

/** Only database-owned payloads are dispatched; never accept browser notes/recipients here. */
export async function dispatchLeaveNotificationOutbox(requestId: string | null = null) {
  let target: ReturnType<typeof receiver>;
  try { target = receiver(); } catch { return { ok: false, code: "not_configured", claimed: 0, sent: 0, failed: 0 }; }
  const admin = createAdminClient();
  const claimed = await admin.rpc("claim_leave_notification_outbox", { p_request_id: requestId, p_limit: requestId ? 1 : 50 });
  if (claimed.error || !Array.isArray(claimed.data)) return { ok: false, code: "claim_failed", claimed: 0, sent: 0, failed: 0 };
  let sent = 0;
  let failed = 0;
  for (let offset = 0; offset < claimed.data.length; offset += 5) {
    await Promise.all(claimed.data.slice(offset, offset + 5).map(async (row) => {
      if (!row.payload || !row.claim_token) { failed++; return; }
      const payload = row.payload;
      const eventKey = `leave:${payload.requestId}:${payload.event}:${createHash("sha256").update(row.delivery_id).digest("hex").slice(0, 24)}`;
      const managerDelivery = payload.event === "leave-submitted" || payload.event === "leave-cancelled";
      const expected = emailList(managerDelivery ? payload.managerEmail : payload.employeeEmails);
      let delivered = false;
      try {
        if (!expected.length) throw new Error("missing_recipient");
        const response = await fetch(target.url, {
          method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000),
          headers: { "Content-Type": "application/json", "X-MAM-Notification-Secret": target.secret },
          body: JSON.stringify({ ...payload, eventKey, employeeNote: bodyNote(payload.employeeNote), managerNote: bodyNote(payload.managerNote) }),
        });
        const receipt = await response.json();
        const actual = emailList(receipt.actualRecipients ?? receipt.actualRecipient);
        delivered = response.ok && receipt.ok === true && (receipt.sent === true || receipt.alreadySent === true)
          && receipt.eventKey === eventKey && JSON.stringify(actual) === JSON.stringify(expected);
      } catch { /* The durable event remains retryable; never log the sensitive payload. */ }
      try {
        const result = await admin.rpc("finish_leave_notification_outbox", {
          p_delivery_id: row.delivery_id, p_claim_token: row.claim_token, p_delivered: delivered,
        });
        if (delivered && !result.error && result.data === true) sent++; else failed++;
      } catch { failed++; }
    }));
  }
  return { ok: failed === 0, code: "processed", claimed: claimed.data.length, sent, failed };
}

/** A best-effort immediate drain after an authorised mutation; cron is the durable fallback. */
export async function dispatchLeaveNotificationsForRequest(requestId: string) {
  try {
    const result = await dispatchLeaveNotificationOutbox(requestId);
    if (!result.ok) console.warn("Leave notification remains queued.", { code: result.code });
  } catch { console.warn("Leave notification remains queued."); }
}
