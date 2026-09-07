import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { isSupabaseConfigured, requireSupabaseConfig } from "@/lib/supabase/config";

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isLoginRoute = pathname.startsWith("/login");
  const isConfirmationRoute = pathname === "/auth/confirm";
  const isCronRoute = pathname === "/api/cron/check-in-reminders"
    || pathname === "/api/cron/leave-priority-reminders"
    || pathname === "/api/cron/leave-attachment-cleanup";
  // The analytics handler verifies its dedicated bearer secret before it
  // accesses data. Let that server-to-server request reach the handler rather
  // than redirecting it to the browser login flow.
  const isAnalyticsRoute = pathname === "/api/analytics/v1";

  if (!isSupabaseConfigured()) {
    if (isLoginRoute) return NextResponse.next({ request });

    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("error", "configuration");
    return NextResponse.redirect(url);
  }

  const { supabaseUrl, supabasePublishableKey } = requireSupabaseConfig();
  let response = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headersToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
        Object.entries(headersToSet).forEach(([key, value]) => response.headers.set(key, value));
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  // This route performs its own constant-time CRON_SECRET check before any
  // database action. It must reach the route handler unauthenticated because
  // the MAM scheduler does not have a browser session.
  const isPublicRoute = isLoginRoute || isConfirmationRoute || isCronRoute || isAnalyticsRoute;

  if (!claims && !isPublicRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
