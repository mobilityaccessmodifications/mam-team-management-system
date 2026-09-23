"use server";

import { createClient } from "@/lib/supabase/server";

export async function listEmployeeTeamDirectory(previewPersonId?: string) {
  if (previewPersonId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(previewPersonId)) {
    throw new Error("The selected employee is unavailable.");
  }
  const supabase = await createClient();
  const { data: user, error: authError } = await supabase.auth.getUser();
  if (authError || !user.user) throw new Error("Your session has expired. Sign in again.");
  const { data, error } = await supabase.rpc("list_employee_team_directory", { p_preview_person_id: previewPersonId ?? null });
  if (error || !Array.isArray(data)) throw new Error("Team employees could not be loaded.");
  return data.map((row: { person_id: string; full_name: string; position_title: string; company_key: "mam" | "equipsy"; parent_id: string | null; manager_name: string | null }) => ({
    id: row.person_id,
    name: row.full_name,
    position: row.position_title,
    company: row.company_key,
    reportsTo: row.parent_id,
    managerName: row.manager_name,
  }));
}
