"use server";
import { requirePortalRoleActor } from "@/lib/portal-role-access";
import { parsePortalRoleCapabilities, ROLE_CAPABILITY_ERROR, type PortalRoleCapabilityResult } from "@/lib/portal-role-capabilities";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function getPortalRoleCapabilities(personId?: string): Promise<PortalRoleCapabilityResult> {
  try {
    if (personId !== undefined && (typeof personId !== "string" || !UUID_PATTERN.test(personId))) throw new Error(ROLE_CAPABILITY_ERROR);
    const { supabase, capabilities } = await requirePortalRoleActor();
    if (personId === undefined) return { ok: true, capabilities };
    if (!capabilities.is_super_admin || !capabilities.can_change_employee_view) throw new Error(ROLE_CAPABILITY_ERROR);
    const { data, error } = await supabase.rpc("get_portal_role_capabilities", { p_person_id: personId });
    if (error) throw new Error(ROLE_CAPABILITY_ERROR);
    return { ok: true, capabilities: parsePortalRoleCapabilities(data, personId) };
  } catch {
    return { ok: false, error: ROLE_CAPABILITY_ERROR };
  }
}
