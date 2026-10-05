import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilities, loadModule } from './helpers/unified-role-harness.mjs';
import { loadActions, personId } from './helpers/directory-action-harness.mjs';
test('server page passes canonical role DTO instead of split legacy capability projections', async () => {
  const calls = [];
  const row = capabilities('account');
  const { default: Home } = loadModule('src/app/page.tsx', {
    '@/components/leave-demo': {LeaveDemo:'LeaveDemo'}, '@/components/role-permission-recovery': {RolePermissionRecovery:'RolePermissionRecovery'},
    '@/app/roles/actions': { getPortalRoleCapabilities: async () => { calls.push('canonical'); return {ok:true,capabilities:row}; } },
    '@/lib/check-in-register': {getCheckInResourceLinks: () => ({})},
    '@/lib/supabase/config': {isSupabaseConfigured: () => true},
    '@/lib/supabase/server': {createClient: async () => ({auth:{getUser:async()=>({data:{user:{id:'synthetic'}}})},rpc:async name=>{calls.push(name);return {data:[row],error:null};}})},
    'next/navigation': {redirect() {assert.fail('valid role cannot redirect');}},
  });
  const tree = await Home({searchParams:Promise.resolve({view:'leave',section:'balance'})});
  assert.deepEqual(tree.props.actorCapabilities,row);
  assert.ok(calls.includes('canonical'));
  assert.ok(!calls.includes('get_portal_workspace_capabilities'));
});
test('ordinary role action rejects P0 assignment and accepts Account/Admin using guarded CAS', async () => {
  for (const role of ['account','admin']) {
    const f = loadActions();
    assert.equal(await f.actions.updateEmployeeDirectoryRole({personId,role,expectedRole:'manager'}),role);
  }
  const f = loadActions();
  const rejected = await f.actions.updateEmployeeDirectoryRole({personId,role:'system_admin',expectedRole:'employee'});
  assert.ok(rejected.error);
  assert.ok(!f.calls.some(call=>call.name==='update_employee_directory_role'));
});
