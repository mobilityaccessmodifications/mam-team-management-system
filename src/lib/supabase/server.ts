import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { requireSupabaseConfig } from "@/lib/supabase/config";
import { createUatFetch, isUatMode } from "@/lib/uat-safety";

export async function createClient() {
  const cookieStore = await cookies();
  const { supabaseUrl, supabasePublishableKey } = requireSupabaseConfig();

  return createServerClient(supabaseUrl, supabasePublishableKey, {
    ...(isUatMode() ? { global: { fetch: createUatFetch(globalThis.fetch.bind(globalThis)) } } : {}),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Server Components cannot write cookies. The request proxy refreshes them.
        }
      },
    },
  });
}
