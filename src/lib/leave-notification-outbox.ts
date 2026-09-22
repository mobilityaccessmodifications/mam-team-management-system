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
  const claimed = await admin.rpc("claim_leave_notification_outbox", { p_request_id: requestId, p_limit: requestId ? 1 : 25 });
  if (claimed.error || !Array.isArray(claimed.data)) return { ok: false, code: "claim_failed", claimed: 0, sent: 0, failed: 0 };
  let sent = 0;
  let failed = 0;
  for (let offset = 0; offset < claimed.data.length; offset += 5) {
    await Promise.all(claimed.data.slice(offset, offset + 5).map(async (row) => {
      if (!row.payload || !row.claim_token) { failed++; return; }
      const payload = row.payload;
      // Separate the applicant from reviewers for every submission, without
      // depending on balance data (which must never enter email payloads).
      const split = payload.event === "leave-submitted";
      const legacySplit = split && payload.leaveBalance?.kind === "sick";
      const legacyEventKey = `leave:${payload.requestId}:${payload.event}:${createHash("sha256")
        .update(row.delivery_id).digest("hex").slice(0, 24)}`;
      const employees = emailList(payload.employeeEmails ?? payload.employeeEmail);
      const managers = emailList(payload.managerEmail);
      const copies = split ? ["reviewers", ...(employees.length ? ["employee"] : [])] : ["shared"];
      const outboundPayload = { ...payload };
      // Legacy queued rows may contain a balance snapshot. Balances are now
      // People Hub-only and must never cross the email webhook boundary.
      delete outboundPayload.leaveBalance;
      let delivered = true;
      for (const audience of copies) {
        const eventKey = `leave:${payload.requestId}:${payload.event}:${createHash("sha256")
          .update(row.delivery_id + (split ? `:${audience}` : "")).digest("hex").slice(0, 24)}`;
        const managerDelivery = payload.event === "leave-submitted" || payload.event === "leave-cancelled";
        const expected = audience === "reviewers" ? managers.filter((email) => !employees.includes(email))
          : audience === "employee" ? employees : managerDelivery ? managers : employees;
        // HR remains a reviewer even if all assigned addresses belong to the applicant.
        if (audience === "reviewers" && !employees.includes("hr@mobilityaccess.com.au")) {
          expected.push("hr@mobilityaccess.com.au");
        }
        const recipients = [...new Set(expected)].sort();
        try {
          if (!recipients.length) throw new Error("missing_recipient");
          const response = await fetch(target.url, {
            method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000),
            headers: { "Content-Type": "application/json", "X-MAM-Notification-Secret": target.secret },
            body: JSON.stringify({ ...outboundPayload, ...(split ? { audience } : {}),
              ...(split && !legacySplit ? { legacyEventKey } : {}),
              eventKey, employeeNote: bodyNote(payload.employeeNote), managerNote: bodyNote(payload.managerNote) }),
          });
          const receipt = await response.json();
          const actual = emailList(receipt.actualRecipients ?? receipt.actualRecipient);
          delivered = response.ok && receipt.ok === true && (receipt.sent === true || receipt.alreadySent === true)
            && receipt.eventKey === eventKey && JSON.stringify(actual) === JSON.stringify(recipients) && delivered;
        } catch { delivered = false; /* Keep the durable event retryable; never log its payload. */ }
      }
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

/** Durable, server-owned comparison alerts; amounts never enter the email. */
export async function dispatchPayrollComparisonAlerts() {
  const target = receiver();
  const admin = createAdminClient();
  const claimed = await admin.rpc("claim_payroll_comparison_alerts");
  if (claimed.error || !Array.isArray(claimed.data)) return { ok: false, claimed: 0, sent: 0 };
  let sent = 0;
  for (const row of claimed.data) {
    let delivered = false;
    const eventKey = `payroll-comparison:${row.batch_id}`;
    try {
      const response = await fetch(target.url, {
        method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000),
        headers: { "Content-Type": "application/json", "X-MAM-Notification-Secret": target.secret },
        body: JSON.stringify({ version: 1, event: "payroll-comparison-alert", eventKey,
          batchId: row.batch_id, differenceCount: row.difference_count }),
      });
      const receipt = await response.json();
      delivered = response.ok && receipt.ok === true && (receipt.sent === true || receipt.alreadySent === true)
        && receipt.eventKey === eventKey && receipt.actualRecipient === "marketing@mobilityaccess.com.au";
    } catch { /* Retain the durable claim for retry without exposing payroll data. */ }
    const result = await admin.rpc("finish_payroll_comparison_alert", {
      p_batch_id: row.batch_id, p_claim_token: row.claim_token, p_delivered: delivered,
    });
    if (delivered && !result.error && result.data === true) sent++;
  }
  return { ok: sent === claimed.data.length, claimed: claimed.data.length, sent };
}
