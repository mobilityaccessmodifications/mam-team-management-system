"use server";

import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { redirect } from "next/navigation";

export type LoginState = {
  status: "idle" | "success" | "error";
  message: string;
  email?: string;
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getAllowedEmail(emailValue: FormDataEntryValue | null) {
  const email = String(emailValue ?? "").trim().toLowerCase();
  if (email.length > 254 || !emailPattern.test(email)) return null;

  const allowedDomains = process.env.MAM_ALLOWED_EMAIL_DOMAINS
    ?.split(",")
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
  if (!allowedDomains?.length) return null;

  const emailDomain = email.split("@").at(-1);
  return emailDomain && allowedDomains.includes(emailDomain) ? email : null;
}

function isRateLimited(error: { status?: number; code?: string }) {
  return error.status === 429
    || error.code === "over_email_send_rate_limit"
    || error.code === "over_request_rate_limit";
}

function isUnknownUser(error: { code?: string }) {
  return error.code === "user_not_found" || error.code === "invalid_credentials";
}

export async function requestSignInCode(
  _previousState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  if (!isSupabaseConfigured()) {
    return {
      status: "error",
      message: "Authentication is not connected yet. Ask the system owner to finish setup.",
    };
  }

  const submittedEmail = String(formData.get("email") ?? "").trim().toLowerCase();
  if (submittedEmail.length > 254 || !emailPattern.test(submittedEmail)) {
    return { status: "error", message: "Enter a valid work email address." };
  }

  if (!process.env.MAM_ALLOWED_EMAIL_DOMAINS?.trim()) {
    return {
      status: "error",
      message: "Work-email access is not configured. Ask the system owner to finish setup.",
    };
  }

  const email = getAllowedEmail(formData.get("email"));
  if (!email) {
    return { status: "error", message: "Use your approved work email address." };
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!appUrl) {
    return {
      status: "error",
      message: "NEXT_PUBLIC_APP_URL is missing. Ask the system owner to finish deployment setup.",
    };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${appUrl}/auth/confirm`,
      shouldCreateUser: false,
    },
  });

  if (error) {
    if (isUnknownUser(error)) {
      return {
        status: "success",
        message: "If this work email has access, a 6-digit code will arrive shortly.",
        email,
      };
    }

    return {
      status: "error",
      message: isRateLimited(error)
        ? "Too many sign-in codes have been requested. Wait up to an hour before trying once more."
        : "The sign-in code could not be sent. Try again or contact the system owner.",
    };
  }

  return {
    status: "success",
    message: "Enter the 6-digit code from your email.",
    email,
  };
}

export async function verifySignInCode(
  _previousState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  if (!isSupabaseConfigured()) {
    return {
      status: "error",
      message: "Authentication is not connected yet. Ask the system owner to finish setup.",
    };
  }

  const email = getAllowedEmail(formData.get("email"));
  if (!email) {
    return { status: "error", message: "Start again with your approved work email address." };
  }

  const token = String(formData.get("token") ?? "").trim();
  if (!/^\d{6}$/.test(token)) {
    return { status: "error", message: "Enter the 6-digit code from your email." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.verifyOtp({ email, token, type: "email" });

  if (error || !data.session) {
    return {
      status: "error",
      message: error && isRateLimited(error)
        ? "Too many code attempts. Wait up to an hour, then request one new code."
        : "That code is invalid or expired. Request a new code and try again.",
    };
  }

  redirect("/");
}

export async function signOut() {
  if (!isSupabaseConfigured()) redirect("/login");

  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (data.user) await supabase.auth.signOut();

  redirect("/login");
}
