"use server";

import { redirect } from "next/navigation";

import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";

export type LoginState = {
  status: "idle" | "error";
  message: string;
};

const ADMIN_USERNAME = "admin";
const ADMIN_EMAIL = "ai@mobilityaccess.com.au";
const INVALID_LOGIN_MESSAGE = "Incorrect username or password.";

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
    username !== ADMIN_USERNAME
    || password.length < 8
    || password.length > 128
  ) {
    return { status: "error", message: INVALID_LOGIN_MESSAGE };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: ADMIN_EMAIL,
    password,
  });

  if (error || !data.session || !data.user) {
    return { status: "error", message: INVALID_LOGIN_MESSAGE };
  }

  const { data: canEditOrganisation, error: permissionError } = await supabase
    .rpc("can_edit_internal_org");

  if (permissionError || canEditOrganisation !== true) {
    await supabase.auth.signOut({ scope: "local" });
    return { status: "error", message: INVALID_LOGIN_MESSAGE };
  }

  redirect("/");
}

export async function signOut() {
  if (!isSupabaseConfigured()) redirect("/login");

  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (data.user) await supabase.auth.signOut({ scope: "local" });

  redirect("/login");
}
