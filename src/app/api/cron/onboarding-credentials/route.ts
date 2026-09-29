import { randomBytes, timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const headers = { "Cache-Control": "no-store" };
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function authorised(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  const expected = Buffer.from(`Bearer ${secret ?? ""}`);
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  return Boolean(secret) && expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
function recipient(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalised = value.trim().toLowerCase();
  return emailPattern.test(normalised) ? normalised : null;
}

export async function GET(request: Request) {
  if (!authorised(request)) return Response.json({ ok: false, code: "unauthorized" }, { status: 401, headers });
  const url = process.env.ONBOARDING_CREDENTIAL_WEBHOOK_URL;
  const secret = process.env.ONBOARDING_CREDENTIAL_WEBHOOK_SECRET;
  if (process.env.ONBOARDING_CREDENTIAL_EMAIL_MODE !== "live" || !url || !secret || !/^https:\/\//.test(url)) {
    return Response.json({ ok: true, code: "delivery_disabled", claimed: 0, sent: 0, failed: 0 }, { headers });
  }
  const admin = createAdminClient();
  const claimed = await admin.rpc("claim_due_onboarding_credentials", { p_limit: 10 });
  if (claimed.error || !Array.isArray(claimed.data)) return Response.json({ ok: false, code: "claim_failed" }, { status: 503, headers });
  let sent = 0;
  let failed = 0;
  for (const item of claimed.data) {
    if (!uuidPattern.test(item.delivery_id) || !uuidPattern.test(item.claim_token) || !uuidPattern.test(item.auth_user_id)) {
      failed++;
      continue;
    }
    const recipients = [...new Set([recipient(item.work_email), recipient(item.personal_email)].filter((address): address is string => Boolean(address)))];
    const login = recipient(item.login_name);
    const fail = async (code: string) => {
      await admin.rpc("fail_onboarding_credential_delivery", { p_delivery_id: item.delivery_id, p_claim_token: item.claim_token, p_code: code });
      failed++;
    };
    if (!login || !recipients.length || !recipients.includes(login)) { await fail("invalid_recipient"); continue; }
    const begin = await admin.rpc("begin_onboarding_credential_delivery", { p_delivery_id: item.delivery_id, p_claim_token: item.claim_token });
    if (begin.error || begin.data !== true) { await fail("invalid_context"); continue; }
    const temporaryPassword = `${randomBytes(24).toString("base64url")}aA1!`;
    try {
      const changed = await admin.auth.admin.updateUserById(item.auth_user_id, { password: temporaryPassword });
      if (changed.error || changed.data.user?.id !== item.auth_user_id) { await fail("password_update_failed"); continue; }
    } catch { await fail("password_update_uncertain"); continue; }
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-mam-onboarding-secret": secret },
        body: JSON.stringify({ version: 1, deliveryId: item.delivery_id, login, temporaryPassword, workEmail: recipient(item.work_email), personalEmail: recipient(item.personal_email), recipients }),
        redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) { await fail("provider_rejected"); continue; }
      const ack = await response.json();
      if (ack?.ok !== true || ack.deliveryId !== item.delivery_id) { await fail("invalid_ack"); continue; }
      const completed = await admin.rpc("complete_onboarding_credential_delivery", { p_delivery_id: item.delivery_id, p_claim_token: item.claim_token });
      if (completed.error || completed.data !== true) { failed++; continue; }
      sent++;
    } catch { await fail("delivery_uncertain"); }
  }
  return Response.json({ ok: failed === 0, claimed: claimed.data.length, sent, failed }, { status: failed ? 503 : 200, headers });
}
