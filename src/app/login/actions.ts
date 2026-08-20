"use server";

import { redirect } from "next/navigation";

import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type LoginState = {
  status: "idle" | "error";
  message: string;
};

const INVALID_LOGIN_MESSAGE = "Incorrect username or password.";

function isValidLoginName(value: string) {
  return /^[a-z0-9][a-z0-9._-]{2,63}$/.test(value);
}

export async function signIn(
  _previousState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  if (!isSupabaseConfigured()) {
    return {
      status: "error",
      message: "Sign-in is unavailable. Try again later.",
    };
  }

  const username = String(formData.get("username") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (
    !isValidLoginName(username)
    || password.length < 8
    || password.length > 128
  ) {
    return { status: "error", message: INVALID_LOGIN_MESSAGE };
  }

  let authEmail = "";
  try {
    const admin = createAdminClient();
    const { data: profile, error: profileError } = await admin
      .from("profiles")
      .select("id,account_status")
      .eq("login_name", username)
      .eq("account_status", "active")
      .maybeSingle<{ id: string; account_status: "active" }>();

    if (profileError || !profile) return { status: "error", message: INVALID_LOGIN_MESSAGE };
    const { data: authUser, error: authUserError } = await admin.auth.admin.getUserById(profile.id);
    if (authUserError || !authUser.user.email) return { status: "error", message: INVALID_LOGIN_MESSAGE };
    authEmail = authUser.user.email;
  } catch {
    return { status: "error", message: INVALID_LOGIN_MESSAGE };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: authEmail,
    password,
  });

  if (error || !data.session || !data.user) {
    return { status: "error", message: INVALID_LOGIN_MESSAGE };
  }

  const { data: account, error: accountError } = await supabase
    .rpc("current_portal_account");

  const current = Array.isArray(account) ? account[0] : null;
  if (accountError || !current || current.account_status !== "active") {
    await supabase.auth.signOut({ scope: "local" });
    return { status: "error", message: INVALID_LOGIN_MESSAGE };
  }

  redirect("/");
}

export async function signOut() {
  if (!isSupabaseConfigured()) return { signedOut: true };

  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "local" });
  return { signedOut: true };
}
