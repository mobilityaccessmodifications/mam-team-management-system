"use server";

import { createHash, randomBytes } from "node:crypto";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { isPortalLoginEmail, normalisePortalLogin } from "@/lib/portal-login";
import {
  PASSWORD_RECOVERY_INVALID, PASSWORD_RECOVERY_MESSAGE, PASSWORD_RECOVERY_PASSWORD_PATTERN,
  PASSWORD_RECOVERY_PASSWORD_RULE, PASSWORD_RECOVERY_TOKEN_PATTERN, PEOPLE_HUB_ORIGIN,
  type PasswordRecoveryState,
} from "@/lib/password-recovery";
import { createAdminClient } from "@/lib/supabase/admin";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const unavailable = (): PasswordRecoveryState => ({ status: "error", message: "Password reset is unavailable. Try again later." });
const invalid = (): PasswordRecoveryState => ({ status: "error", message: PASSWORD_RECOVERY_INVALID });

function deliveryConfig() {
  const url = process.env.PASSWORD_RECOVERY_WEBHOOK_URL;
  const secret = process.env.PASSWORD_RECOVERY_WEBHOOK_SECRET;
  try {
    const target = new URL(url ?? "");
    const origin = new URL(process.env.PASSWORD_RECOVERY_WEBHOOK_ORIGIN ?? "");
    if (!secret || !url || target.protocol !== "https:" || origin.protocol !== "https:"
      || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password
      || target.origin !== origin.origin || target.username || target.password || target.search || target.hash
      || target.pathname !== "/webhook/mam-people-hub-password-recovery-v1") return null;
    return { url, secret };
  } catch { return null; }
}

export async function requestPasswordRecovery(
  _previousState: PasswordRecoveryState, formData: FormData,
): Promise<PasswordRecoveryState> {
  const email = normalisePortalLogin(String(formData.get("email") ?? ""));
  if (!isPortalLoginEmail(email)) return { status: "error", message: "Enter a valid email address." };
  const config = deliveryConfig();
  if (!config) return unavailable();
  const startedAt = Date.now();
  try {
    const requestHeaders = await headers();
    const source = requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim()
      || requestHeaders.get("x-real-ip")?.trim() || "unknown";
    const admin = createAdminClient();
    const limit = await admin.rpc("claim_portal_login_attempt", {
      p_login_hash: sha256(`password-recovery:${email}`), p_source_hash: sha256(`password-recovery:${source}`),
    });
    if (limit.error) return unavailable();
    if (limit.data === true) {
      const token = randomBytes(32).toString("base64url");
      const issued = await admin.rpc("issue_portal_password_recovery", { p_email: email, p_token_hash: sha256(token) });
      if (issued.error) return unavailable();
      const row = Array.isArray(issued.data) ? issued.data[0] : null;
      if (row) {
        if (row.recipient !== email || typeof row.request_id !== "string") return unavailable();
        const resetUrl = `${PEOPLE_HUB_ORIGIN}/login/reset-password#token=${token}`;
        try {
          const response = await fetch(config.url, {
            method: "POST", headers: { "content-type": "application/json", "x-mam-password-recovery-secret": config.secret },
            body: JSON.stringify({ version: 1, requestId: row.request_id, recipient: row.recipient, resetUrl }),
            redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20_000),
          });
          const ack = response.ok ? await response.json() : null;
          if (ack?.ok !== true || ack.sent !== true || ack.requestId !== row.request_id) {
            console.error("Password recovery delivery was not confirmed.");
          }
        } catch { console.error("Password recovery delivery could not be confirmed."); }
      }
    }
  } catch {
    console.error("Password recovery request could not be completed.");
    return unavailable();
  } finally {
    const remaining = 700 - (Date.now() - startedAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  }
  return { status: "success", message: PASSWORD_RECOVERY_MESSAGE };
}

export async function resetRecoveredPassword(
  _previousState: PasswordRecoveryState, formData: FormData,
): Promise<PasswordRecoveryState> {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  if (!PASSWORD_RECOVERY_TOKEN_PATTERN.test(token)) return invalid();
  if (!PASSWORD_RECOVERY_PASSWORD_PATTERN.test(password)) return { status: "error", message: PASSWORD_RECOVERY_PASSWORD_RULE };
  if (password !== String(formData.get("confirmPassword") ?? "")) return { status: "error", message: "The passwords do not match." };
  let admin: ReturnType<typeof createAdminClient>;
  try { admin = createAdminClient(); } catch { return unavailable(); }
  let claim;
  try {
    const result = await admin.rpc("begin_portal_password_recovery", { p_token_hash: sha256(token) });
    if (result.error) return { status: "error", message: "Password reset could not be completed. Request a new link or contact your administrator." };
    claim = Array.isArray(result.data) ? result.data[0] : null;
  } catch { return unavailable(); }
  if (!claim) return invalid();
  try {
    const changed = await admin.auth.admin.updateUserById(claim.auth_user_id, { password });
    if (changed.error) {
      if (changed.error.status === 400 || changed.error.status === 422) {
        await admin.rpc("finish_portal_password_recovery", { p_auth_user_id: claim.auth_user_id, p_reset_token: claim.reset_token, p_applied: false });
        return { status: "error", message: "The password could not be saved. Request a new link and try again." };
      }
      return { status: "error", message: "The password-reset result could not be confirmed. Contact your administrator before trying again." };
    }
    if (changed.data.user?.id !== claim.auth_user_id) return unavailable();
  } catch {
    return { status: "error", message: "The password-reset result could not be confirmed. Contact your administrator before trying again." };
  }
  const input = { p_auth_user_id: claim.auth_user_id, p_reset_token: claim.reset_token, p_applied: true };
  try {
    let result = await admin.rpc("finish_portal_password_recovery", input);
    if (result.error || result.data !== true) result = await admin.rpc("finish_portal_password_recovery", input);
    if (result.error || result.data !== true) return { status: "error", message: "Your password changed, but the account update could not be confirmed. Contact your administrator." };
  } catch {
    return { status: "error", message: "Your password changed, but the account update could not be confirmed. Contact your administrator." };
  }
  redirect("/login?password=reset");
}
