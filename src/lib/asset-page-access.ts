import "server-only";

import { notFound, redirect } from "next/navigation";
import { assetLoginReturnPath } from "@/lib/asset-qr";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";

export async function requireActiveAssetAccount(returnTo: string) {
  const destination = assetLoginReturnPath(returnTo) ?? "/assets/scan";
  const login = `/login?next=${encodeURIComponent(destination)}`;
  if (!isSupabaseConfigured()) redirect(login);
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) redirect(login);

  const { data: accounts, error: accountError } = await supabase.rpc("current_portal_account");
  const account = Array.isArray(accounts) ? accounts[0] : null;
  if (accountError || !account || account.account_status !== "active") notFound();

  const { data: permission, error: permissionError } = await supabase.rpc("can_manage_it_assets");
  return { canManageAssets: !permissionError && permission === true };
}
