import "server-only";

import { createClient } from "@supabase/supabase-js";

import { requireSupabaseConfig } from "@/lib/supabase/config";
import { createUatFetch, isUatMode } from "@/lib/uat-safety";

function createSecretKeyCompatibleFetch(secretKey: string): typeof fetch | undefined {
  // @supabase/supabase-js 2.111.0 still initializes its Auth client with the
  // supplied key as a Bearer token. New `sb_secret_` keys are API keys rather
  // than JWTs, so Supabase requires them in `apikey` only. This hook runs only
  // on the isolated admin client and removes only that exact SDK fallback.
  if (!secretKey.startsWith("sb_secret_")) return undefined;

  const sdkAuthorization = `Bearer ${secretKey}`;

  return async (input, init) => {
    const requestHeaders =
      typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined;
    const headers = new Headers(init?.headers ?? requestHeaders);

    if (headers.get("Authorization") === sdkAuthorization) {
      headers.delete("Authorization");
    }

    return globalThis.fetch(input, { ...init, headers });
  };
}

export function createAdminClient() {
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!secretKey) {
    throw new Error("The account administration service is not configured.");
  }

  const { supabaseUrl } = requireSupabaseConfig();

  return createClient(supabaseUrl, secretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      fetch: isUatMode()
        ? createUatFetch(createSecretKeyCompatibleFetch(secretKey) ?? globalThis.fetch.bind(globalThis))
        : createSecretKeyCompatibleFetch(secretKey),
    },
  });
}
