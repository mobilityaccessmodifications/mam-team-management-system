import type { EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";

function safeNextPath(request: NextRequest, value: string | null) {
  if (!value?.startsWith("/") || value.includes("\\")) return "/";
  try {
    const destination = new URL(value, request.nextUrl.origin);
    if (
      destination.origin !== request.nextUrl.origin
      || !destination.pathname.startsWith("/")
      || destination.pathname.startsWith("//")
      || destination.pathname.includes("\\")
    ) return "/";
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return "/";
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const requestedNext = searchParams.get("next");
  const next = safeNextPath(request, requestedNext);

  if (tokenHash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) {
      redirect(next);
    }
  }

  redirect("/login?error=confirmation");
}
