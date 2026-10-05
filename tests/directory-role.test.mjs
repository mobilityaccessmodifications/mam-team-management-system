import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import test from 'node:test';
import { loadActions, personId } from './helpers/directory-action-harness.mjs';
import { loadModule } from './helpers/unified-role-harness.mjs';
const ui = readFileSync('src/components/employee-directory.tsx', 'utf8');
const migrationPath = 'supabase/migrations/20260930130000_directory_role_control.sql';
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
const css = readFileSync('src/components/employee-directory.module.css', 'utf8');
const sqlRunner = readFileSync('scripts/test-sql.mjs', 'utf8');
test('role action validates ordinary roles and rechecks actual P0', async () => {
  for (const role of ['employee','manager','account','admin']) {
    const f = loadActions();
    assert.equal(await f.actions.updateEmployeeDirectoryRole({personId,role,expectedRole:'employee'}),role);
    assert.deepEqual(f.calls.slice(0,2),[
      {name:'get_portal_role_capabilities',args:{p_person_id:null}},
      {name:'update_employee_directory_role',args:{p_person_id:personId,p_role:role,p_expected_role:'employee'}},
    ]);
  }
  for (const role of ['hr','system_admin','invalid']) {
    const f = loadActions();
    assert.match((await f.actions.updateEmployeeDirectoryRole({personId,role,expectedRole:'employee'})).error,/valid role/);
    assert.equal(f.calls.length,0);
  }
  const denied = loadActions({roleAccess:false});
  assert.match((await denied.actions.updateEmployeeDirectoryRole({personId,role:'admin',expectedRole:'employee'})).error,/Only a Super Admin/);
  assert.deepEqual(denied.calls.map(c=>c.name),['get_portal_role_capabilities']);
});
test('role control remains edit-only with four permission cards, never P0 or legacy HR', () => {
  assert.doesNotMatch(ui, /<EmployeePicker\b/);
  assert.match(ui, /!isCreate && canManageRoles && role !== "system_admin"/);
  assert.match(ui, /updateEmployeeDirectoryRole/);
  assert.match(ui, /listEmployeeDirectoryRoles/);
  assert.match(ui, /Save role/);
  assert.match(ui, /ROLE_PERMISSION_CARDS/);
  assert.doesNotMatch(ui, /<option value="(?:hr|system_admin)"/);
  const cards = loadModule('src/lib/portal-role-permissions.ts').ROLE_PERMISSION_CARDS;
  assert.deepEqual(Object.keys(cards),['employee','manager','account','admin']);
  assert.match(cards.account.can,/all-status.*notes.*evidence/);
  assert.match(cards.account.cannot,/commit balances/);
  assert.match(cards.manager.delegation,/separate optional switches/);
  assert.match(cards.admin.cannot,/assign roles.*Change profile.*analytics\/security.*subscription delegates/);
  assert.match(css, /\.roleImpact\s*\{/);
});
test('SQL role mutation checks caller and target, audits and never touches independent grants', () => {
  assert.match(migration, /^begin;[\s\S]*commit;\s*$/);
  assert.match(migration, /private\.is_system_portal_account_admin\(\)/);
  assert.match(migration, /private\.is_active_portal_account/);
  assert.match(migration, /private\.employee_directory_audit_events/);
  assert.match(migration, /app_role/);
  assert.doesNotMatch(migration, /(?:update|delete from) private\.[a-z_]*grants/i);
  assert.match(sqlRunner, /tests\/directory-role\.sql/);
});
