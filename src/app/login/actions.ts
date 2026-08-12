"use server";

import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { redirect } from "next/navigation";

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
      message: "Authentication is not connected yet. Ask the system owner to finish setup.",
    };
  }

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { status: "error", message: "Enter a valid work email address." };
  }

  const allowedDomains = process.env.MAM_ALLOWED_EMAIL_DOMAINS
    ?.split(",")
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
  if (!allowedDomains?.length) {
    return {
      status: "error",
      message: "Work-email access is not configured. Ask the system owner to finish setup.",
    };
  }

  const emailDomain = email.split("@").at(-1);
  if (!emailDomain || !allowedDomains.includes(emailDomain)) {
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

export async function signOut() {
  if (!isSupabaseConfigured()) redirect("/login");

  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (data.user) await supabase.auth.signOut();

  redirect("/login");
}
