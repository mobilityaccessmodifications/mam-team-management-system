"use server";

import { createClient } from "@/lib/supabase/server";

export type AccountsReportRow = {
  person_id: string;
  employee_name: string;
  team_lead: string;
  team: string;
  company: string;
  location: string | null;
  work_days: number[] | null;
  daily_times: { weekday: number; start_time: string; end_time: string }[];
  expected_hours: number | null;
  employment_type: string | null;
  timesheet_entries: string | null;
};

export async function fetchAccountsReport(): Promise<{ rows: AccountsReportRow[] } | { error: string }> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("list_accounts_employee_report");
    if (error || !Array.isArray(data)) return { error: "Accounts Report is unavailable or you do not have permission." };
    return { rows: data as AccountsReportRow[] };
  } catch {
    return { error: "Accounts Report could not be loaded. Refresh and try again." };
  }
}
