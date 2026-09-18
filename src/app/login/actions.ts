"use server";

import { createHash } from "node:crypto";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { isValidPortalLogin, normalisePortalLogin } from "@/lib/portal-login";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type LoginState = {
  status: "idle" | "error";
  message: string;
};

const INVALID_LOGIN_MESSAGE = "Incorrect email, username or password.";
const DUMMY_AUTH_EMAIL = "invalid-portal-login@invalid.example";
const MINIMUM_FAILED_LOGIN_MS = 500;

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function loginFingerprints(username: string) {
  const requestHeaders = await headers();
  const forwardedAddress = requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim();
  const source = forwardedAddress
    || requestHeaders.get("x-real-ip")?.trim()
    || `unknown:${requestHeaders.get("user-agent")?.slice(0, 256) ?? "client"}`;
  return {
    loginHash: sha256(username),
    sourceHash: sha256(source),
  };
}

async function invalidLogin(startedAt: number): Promise<LoginState> {
  const remaining = MINIMUM_FAILED_LOGIN_MS - (Date.now() - startedAt);
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
  return { status: "error", message: INVALID_LOGIN_MESSAGE };
}

export async function signIn(
  _previousState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const startedAt = Date.now();
  if (!isSupabaseConfigured()) {
    return {
      status: "error",
      message: "Sign-in is unavailable. Try again later.",
    };
  }

  const username = normalisePortalLogin(String(formData.get("username") ?? ""));
  const password = String(formData.get("password") ?? "");
  if (
    !isValidPortalLogin(username)
    || password.length < 8
    || password.length > 128
  ) {
    return invalidLogin(startedAt);
  }

  const { loginHash, sourceHash } = await loginFingerprints(username);
  let authEmail: string | null = null;
  let attemptAllowed = false;
  let admin: ReturnType<typeof createAdminClient> | null = null;
  try {
    admin = createAdminClient();
    const [limitResult, emailResult] = await Promise.all([
      admin.rpc("claim_portal_login_attempt", {
        p_login_hash: loginHash,
        p_source_hash: sourceHash,
      }),
      admin.rpc("resolve_portal_login_auth_email", {
        p_login_name: username,
      }),
    ]);
    attemptAllowed = !limitResult.error && limitResult.data === true;
    authEmail = !emailResult.error && typeof emailResult.data === "string"
      ? emailResult.data
      : null;
  } catch {
    // Fail closed. The dummy provider request below keeps unknown, blocked and
    // temporarily unavailable account lookups on the same external path.
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: attemptAllowed && authEmail ? authEmail : DUMMY_AUTH_EMAIL,
    password,
  });

  if (!attemptAllowed || !authEmail || error || !data.session || !data.user) {
    if (data.session) await supabase.auth.signOut({ scope: "local" });
    return invalidLogin(startedAt);
  }

  const { data: account, error: accountError } = await supabase
    .rpc("current_portal_account");

  const current = Array.isArray(account) ? account[0] : null;
  if (accountError || !current || current.account_status !== "active") {
    await supabase.auth.signOut({ scope: "local" });
    return invalidLogin(startedAt);
  }

  await admin?.rpc("clear_portal_login_rate_limit", {
    p_login_hash: loginHash,
    p_source_hash: sourceHash,
  });

  redirect("/");
}

export async function signOut() {
  if (!isSupabaseConfigured()) return { signedOut: true };

  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "local" });
  return { signedOut: true };
}
