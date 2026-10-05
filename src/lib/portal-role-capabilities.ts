export type OrdinaryPortalRole = "employee" | "manager" | "account" | "admin";
export type PortalRole = OrdinaryPortalRole | "system_admin";
export const ORDINARY_PORTAL_ROLES: OrdinaryPortalRole[] = ["employee", "manager", "account", "admin"];
export const ROLE_CAPABILITY_FIELDS = [
  "is_super_admin", "can_manage_accounts", "can_view_employee_directory", "can_manage_employee_directory",
  "can_view_organisation_chart", "can_edit_organisation_chart", "can_change_employee_view", "can_view_check_in_workspace",
  "can_manage_assets", "can_view_subscription_register", "can_manage_subscriptions", "can_manage_subscription_credentials",
  "can_manage_subscription_credential_grants", "can_manage_subscription_management_grants", "can_manage_roles",
  "can_manage_analytics_api", "can_import_payroll_balances", "payroll_comparison_only", "can_manage_leave_balances",
  "can_view_all_leave_requests", "can_review_leave_workspace", "can_approve_employment_decisions",
] as const;
export type PortalRoleCapabilities = {
  app_role: PortalRole;
  person_id: string | null;
  account_status: "active";
} & Record<typeof ROLE_CAPABILITY_FIELDS[number], boolean>;
export const ROLE_CAPABILITY_ERROR = "Role permissions could not be loaded. Retry before using this profile.";
export type PortalRoleCapabilityResult = { ok: true; capabilities: PortalRoleCapabilities } | { ok: false; error: string };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parsePortalRoleCapabilities(data: unknown, personId: string | null = null): PortalRoleCapabilities {
  if (!Array.isArray(data) || data.length !== 1) throw new Error(ROLE_CAPABILITY_ERROR);
  const row = data[0];
  if (!row || typeof row !== "object" || ![...ORDINARY_PORTAL_ROLES, "system_admin"].includes(row.app_role)
    || row.account_status !== "active" || (row.person_id === null ? row.app_role !== "system_admin" : typeof row.person_id !== "string" || !UUID_PATTERN.test(row.person_id))
    || (personId !== null && row.person_id !== personId)
    || ROLE_CAPABILITY_FIELDS.some(field => typeof row[field] !== "boolean")) throw new Error(ROLE_CAPABILITY_ERROR);
  return {
    app_role: row.app_role, person_id: row.person_id, account_status: "active",
    ...Object.fromEntries(ROLE_CAPABILITY_FIELDS.map(field => [field, row[field]])),
  } as PortalRoleCapabilities;
}
