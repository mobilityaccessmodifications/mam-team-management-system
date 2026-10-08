import type { OrdinaryPortalRole } from "@/lib/portal-role-capabilities";
export const ROLE_PERMISSION_CARDS: Record<OrdinaryPortalRole, { label: string; can: string; cannot: string; scope: string; delegation?: string }> = {
  employee: {
    label: "Team member",
    can: "Use own profile, leave, availability calendar, resources and work-schedule requests; view the safe team directory.",
    cannot: "Approve leave, edit staff or accounts, manage payroll balances, manage subscriptions or access credentials without delegation, or administer the system.",
    scope: "Own records and the privacy-preserving team view.",
    delegation: "Subscription register management and credential-vault access are separate optional switches controlled by Super Admin. Neither grant implies the other.",
  },
  manager: {
    label: "Manager",
    can: "Review reporting-team leave and work-schedule requests, submit leave on behalf of eligible reports, review check-ins and edit manager-safe directory fields; view Organisation and the read-only subscription register.",
    cannot: "Approve own leave, edit private HR fields or portal accounts, commit payroll balances, change roles or system settings.",
    scope: "Current reporting tree and existing company/record rules; no self-approval.",
    delegation: "Subscription register management and credential-vault access are separate optional switches controlled by Super Admin. Neither grant implies the other.",
  },
  account: {
    label: "Account",
    can: "Read the all-status leave register, existing notes and existing evidence; view pending/approved staff calendar and retained approved history across MAM and Equipsy; upload payroll files for comparison-only results; use own employee workflows.",
    cannot: "Decide or cancel another person's leave, upload/delete their evidence, submit leave on behalf, edit staff/accounts, review global birthdays/check-ins, access the credential vault or commit balances, edit balances/accrual or change system settings.",
    scope: "Read-only staff leave across both supported companies; retained uploads and immutable comparisons stay uploader-scoped.",
  },
  admin: {
    label: "Admin",
    can: "Administer Directory/CSV, Organisation, portal account provisioning/reset/status/login, devices, subscription register and credentials, global leave review, manual balances/accrual, check-ins, employment decisions and work schedules.",
    cannot: "Approve own leave, assign roles, use Change profile, configure analytics/security or subscription delegates, or purge confirmed test identities.",
    scope: "All-module daily operations, preserving existing record, company, audit and anti-self rules. P0 controls remain exclusive to Super Admin.",
  },
};
