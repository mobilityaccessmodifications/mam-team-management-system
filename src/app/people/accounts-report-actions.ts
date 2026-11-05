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

export type PayrollLeaveRequest = {
  id: string;
  person_id: string;
  leave_type: "annual" | "personal" | "unpaid";
  label: string;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
  hours: number | string | null;
  business_days: number;
  status: "approved" | "submitted" | "rejected" | "cancelled";
  pay_treatment: string | null;
};
export type PayrollHoliday = { date: string; name: string };
export type AccountsPayrollWeek = {
  week_start: string;
  week_end: string;
  leave: PayrollLeaveRequest[];
  holidays: PayrollHoliday[];
};
export async function fetchAccountsPayrollWeek(weekStart: string):
  Promise<{ data: AccountsPayrollWeek } | { error: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return { error: "Select a valid Monday work week." };
  }
  try {
    const date = new Date(weekStart + "T12:00:00Z");
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== weekStart
        || date.getUTCDay() !== 1) return { error: "Work week must begin on Monday." };
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("get_accounts_payroll_week", { p_week_start: weekStart });
    if (error || !data || !Array.isArray(data.leave) || !Array.isArray(data.holidays)) {
      return { error: "Payroll leave data could not be loaded, or you do not have access." };
    }
    return { data: data as AccountsPayrollWeek };
  } catch {
    return { error: "Could not load this payroll week. Refresh and retry." };
  }
}
