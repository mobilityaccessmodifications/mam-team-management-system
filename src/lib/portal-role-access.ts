import "server-only";
import { parsePortalRoleCapabilities, ROLE_CAPABILITY_ERROR } from "@/lib/portal-role-capabilities";
import { createClient } from "@/lib/supabase/server";
export async function requirePortalRoleActor() {
  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new Error(ROLE_CAPABILITY_ERROR);
  const { data, error } = await supabase.rpc("get_portal_role_capabilities", { p_person_id: null });
  if (error) throw new Error(ROLE_CAPABILITY_ERROR);
  return { supabase, actorUserId: userData.user.id, capabilities: parsePortalRoleCapabilities(data) };
}
