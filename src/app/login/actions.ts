"use server";

import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";

export type LoginState = {
  status: "idle" | "success" | "error";
  message: string;
};

export async function requestSignInLink(
  _previousState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  if (!isSupabaseConfigured()) {
    return {
      status: "error",
      message: "Authentication is not connected yet. Add the MAM Supabase environment first.",
    };
  }

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { status: "error", message: "Enter a valid work email address." };
  }

  const allowedDomain = process.env.MAM_ALLOWED_EMAIL_DOMAIN?.trim().toLowerCase();
  if (allowedDomain && !email.endsWith(`@${allowedDomain}`)) {
    return { status: "error", message: "Use your approved MAM work email address." };
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
    options: { emailRedirectTo: `${appUrl}/auth/confirm` },
  });

  if (error) {
    return { status: "error", message: "The sign-in link could not be sent. Try again or contact the system owner." };
  }

  return {
    status: "success",
    message: "Check your inbox for a secure sign-in link.",
  };
}
