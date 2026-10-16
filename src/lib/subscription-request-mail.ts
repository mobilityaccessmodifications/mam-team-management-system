import "server-only";
import { isUatMode } from "@/lib/uat-safety";
import { createAdminClient } from "@/lib/supabase/admin";

export const SUBSCRIPTION_REQUEST_MAIL_PATH = "/webhook/mam-subscription-request-mail-v2";
export const SUBSCRIPTION_REQUEST_TEMPLATE_MAIL_PATH = "/webhook/mam-subscription-request-mail-v3";
const email = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

function receiver() {
  const secret = process.env.MAM_N8N_LEAVE_WEBHOOK_SECRET?.trim();
  const origin = new URL(process.env.MAM_N8N_LEAVE_WEBHOOK_ORIGIN ?? "");
  if (!secret || origin.protocol !== "https:" || origin.pathname !== "/" || origin.username || origin.password || origin.search || origin.hash) throw Error("not_configured");
  return { origin, secret };
}

export async function dispatchSubscriptionRequestMail(requestId: string | null = null) {
  if (isUatMode()) return { ok: false, claimed: 0, sent: 0 };
  try {
    const target = receiver();
    const admin = createAdminClient();
    const claimed = await admin.rpc("claim_subscription_request_mail", { p_request_id: requestId, p_limit: requestId ? 1 : 10 });
    if (claimed.error || !Array.isArray(claimed.data)) return { ok: false, claimed: 0, sent: 0 };
    let sent = 0;
    for (const row of claimed.data) {
      const payload = row.payload;
      if (!payload || !row.claim_token || (payload.version !== 2 && payload.version !== 3) || typeof payload.applicantWorkEmail !== "string" || !email.test(payload.applicantWorkEmail) || typeof payload.approverWorkEmail !== "string" || !email.test(payload.approverWorkEmail)) continue;
      const cc = payload.applicantWorkEmail === payload.approverWorkEmail ? "" : payload.applicantWorkEmail;
      try {
        const path = payload.version === 3 ? SUBSCRIPTION_REQUEST_TEMPLATE_MAIL_PATH : SUBSCRIPTION_REQUEST_MAIL_PATH;
        const response = await fetch(new URL(path, target.origin), {
          method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000),
          headers: { "Content-Type": "application/json", "X-MAM-Notification-Secret": target.secret },
          body: JSON.stringify(payload),
        });
        const receipt = await response.json();
        const delivered = response.ok && receipt.ok === true && (receipt.sent === true || receipt.alreadySent === true)
          && receipt.deliveryId === payload.deliveryId && receipt.actualRecipient === payload.approverWorkEmail && receipt.actualCcRecipients === cc;
        if (!delivered) continue;
        const finished = await admin.rpc("finish_subscription_request_mail", {
          p_request_id: row.request_id, p_version: row.version, p_claim_token: row.claim_token, p_delivered: true,
        });
        if (!finished.error && finished.data === true) sent++;
      } catch { continue; }
    }
    return { ok: sent === claimed.data.length, claimed: claimed.data.length, sent };
  } catch { return { ok: false, claimed: 0, sent: 0 }; }
}
