import "server-only";
import { isUatMode } from "@/lib/uat-safety";
import { createAdminClient } from "@/lib/supabase/admin";

export const SUBSCRIPTION_REVIEW_MAIL_PATH = "/webhook/mam-subscription-review-mail-v1";
const email = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const deliveryId = /^subscription-review:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01]):(upcoming|due)$/;

export async function dispatchSubscriptionReviewMail(deadline = Date.now() + 90_000) {
  if (isUatMode()) return { ok: false, selected: 0, sent: 0 };
  const startOn = process.env.MAM_SUBSCRIPTION_REVIEW_MAIL_START_ON?.trim();
  if (!startOn) return { ok: true, selected: 0, sent: 0 };
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startOn) || new Date(startOn).toISOString().slice(0, 10) !== startOn) throw Error("not_configured");
    const secret = process.env.MAM_N8N_LEAVE_WEBHOOK_SECRET?.trim();
    const origin = new URL(process.env.MAM_N8N_LEAVE_WEBHOOK_ORIGIN ?? "");
    if (!secret || origin.protocol !== "https:" || origin.pathname !== "/" || origin.username || origin.password || origin.search || origin.hash) throw Error("not_configured");
    const admin = createAdminClient();
    const selected = await admin.rpc("list_subscription_review_mail", { p_start_on: startOn, p_limit: 5 });
    if (selected.error || !Array.isArray(selected.data)) return { ok: false, selected: 0, sent: 0 };
    let sent = 0;
    for (const row of selected.data) {
      if (Date.now() + 15_000 > deadline) break;
      const p = row.payload;
      if (!p || p.version !== 1 || p.event !== "subscription-review-reminder" || typeof p.deliveryId !== "string" || !deliveryId.test(p.deliveryId)
        || typeof p.toRecipients !== "string" || p.toRecipients.length > 8192 || p.toRecipients.split(",").length > 32
        || !p.toRecipients.split(",").every((address: string) => email.test(address) && address === address.trim().toLowerCase())
        || p.toRecipients !== [...new Set(p.toRecipients.split(","))].sort().join(",")) continue;
      try {
        const response = await fetch(new URL(SUBSCRIPTION_REVIEW_MAIL_PATH, origin), {
          method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000),
          headers: { "Content-Type": "application/json", "X-MAM-Notification-Secret": secret },
          body: JSON.stringify(p),
        });
        const receipt = await response.json();
        if (response.ok && receipt.ok === true && (receipt.sent === true || receipt.alreadySent === true)
          && receipt.deliveryId === p.deliveryId && receipt.actualRecipient === p.toRecipients && receipt.actualCcRecipients === "") sent++;
      } catch { continue; }
    }
    return { ok: sent === selected.data.length, selected: selected.data.length, sent };
  } catch { return { ok: false, selected: 0, sent: 0 }; }
}
