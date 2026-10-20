import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pageSource = readFileSync("src/app/page.tsx", "utf8");
const leaveSource = readFileSync("src/components/leave-demo.tsx", "utf8");
const peopleSource = readFileSync("src/components/people-operations-demo.tsx", "utf8");
const subscriptionActionsSource = readFileSync("src/app/subscriptions/actions.ts", "utf8");
const migrationSource = readFileSync(
  "supabase/migrations/20260917123501_people_operational_tab_access.sql",
  "utf8",
);

test("Organisation and the company subscription register are selected from server capabilities", () => {
  assert.match(pageSource, /supabase\.rpc\("get_portal_role_capabilities", \{ p_person_id: null \}\)/);
  assert.match(pageSource, /parsePortalRoleCapabilities\(roleResult\.data\)/);
  assert.match(pageSource, /catch \{\s+return <RolePermissionRecovery/);
  assert.match(pageSource, /actorCapabilities=\{actor\}/);
  assert.match(leaveSource, /showOrganisation=\{showOrganisationChart\}/);
  assert.match(peopleSource, /\.\.\.\(showOrganisation \? \["organisation" as const\] : \[\]\)/);
  assert.match(peopleSource, /visibleSection === "organisation" && showOrganisation/);
  assert.doesNotMatch(peopleSource, /availableSections\[0\] \?\? "organisation"/);
});

test("employee previews hide operational tabs while authorised roles retain them", () => {
  assert.match(
    leaveSource,
    /showOrganisationChart = activeCapabilities\?\.can_view_organisation_chart === true/,
  );
  assert.match(
    leaveSource,
    /showSubscriptionRegister = activeCapabilities\?\.can_view_subscription_register === true[\s\S]*?activeCapabilities\?\.can_manage_subscription_credentials === true/,
  );
  assert.match(leaveSource, /canAccessOwnSubscriptions[\s\S]*?listMySubscriptions/);
});

test("database access is role-based, row-scoped for employees, and keeps writes admin-only", () => {
  const capabilityBody = migrationSource.match(
    /create function private\.can_view_people_operational_tabs\(\)[\s\S]*?\n\$\$;/,
  )?.[0] ?? "";

  assert.match(capabilityBody, /private\.is_system_portal_account_admin\(\)/);
  assert.match(capabilityBody, /profile\.app_role in \('manager', 'hr'\)/);
  assert.doesNotMatch(capabilityBody, /full_name|position_title/);
  assert.match(
    migrationSource,
    /create or replace function public\.can_view_subscription_register\(\)[\s\S]*?private\.can_view_people_operational_tabs\(\)/,
  );
  assert.match(
    migrationSource,
    /create function public\.can_view_internal_org_node\(p_node_id uuid\)[\s\S]*?private\.can_view_people_operational_tabs\(\)[\s\S]*?private\.list_current_employee_people_branch_node_ids\(\)[\s\S]*?create policy internal_org_people_select_people_workspace[\s\S]*?public\.can_view_internal_org_node\(id\)/,
  );
  assert.match(subscriptionActionsSource, /requireSubscriptionAdministrator[\s\S]*?can_manage_subscriptions/);
});
