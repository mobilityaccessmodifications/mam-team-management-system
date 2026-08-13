import "server-only";

import { createClient } from "@supabase/supabase-js";

import { requireSupabaseConfig } from "@/lib/supabase/config";

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
  });
}
