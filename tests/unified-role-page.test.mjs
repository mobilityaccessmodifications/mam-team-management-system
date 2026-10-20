import assert from 'node:assert/strict';
import test from 'node:test';
import { actorId, capabilities, deferred, flush, loadModule } from './helpers/unified-role-harness.mjs';
import { loadActions, personId } from './helpers/directory-action-harness.mjs';
function homeFixture({ configured = true, user = { id: actorId }, authError = null, authThrows = false, rpc } = {}) {
  const calls = [];
  let authCalls = 0;
  const { default: Home } = loadModule('src/app/page.tsx', {
    '@/components/leave-demo': {LeaveDemo:'LeaveDemo'}, '@/components/role-permission-recovery': {RolePermissionRecovery:'RolePermissionRecovery'},
    '@/lib/check-in-register': {getCheckInResourceLinks: () => ({})},
    '@/lib/supabase/config': {isSupabaseConfigured: () => configured},
    '@/lib/supabase/server': {createClient: async () => ({
      auth: {getUser: async () => {
        authCalls++;
        if (authThrows) throw new Error('Synthetic auth transport failure');
        return {data:{user},error:authError};
      }},
      rpc: (name, args) => {
        calls.push({name,args});
        assert.ok(['get_portal_role_capabilities', 'can_view_subscription_review_calendar'].includes(name));
        return rpc ? rpc(name, args) : Promise.resolve({data:name === 'get_portal_role_capabilities' ? [capabilities('account')] : false,error:null,status:200});
      },
    })},
    'next/navigation': {redirect(path) {throw new Error('redirect:'+path);}},
  });
  return {calls, authCalls: () => authCalls, load: params => Home({searchParams:Promise.resolve(params ?? {view:'leave',section:'balance'})})};
}

test('server page authenticates once and starts independent canonical role and calendar reads together', async () => {
  const role = deferred(), calendar = deferred();
  const row = capabilities('account');
  const h = homeFixture({rpc:name => name === 'get_portal_role_capabilities' ? role.promise : calendar.promise});
  let settled = false;
  const loading = h.load().finally(() => {settled = true;});
  await flush();
  assert.equal(h.authCalls(),1);
  assert.deepEqual(h.calls,[
    {name:'get_portal_role_capabilities',args:{p_person_id:null}},
    {name:'can_view_subscription_review_calendar',args:undefined},
  ]);
  assert.equal(settled,false);
  calendar.resolve({data:true,error:null,status:200});
  await flush();
  assert.equal(settled,false);
  role.resolve({data:[{...row,untrusted_extra:'Discard this field'}],error:null,status:200});
  const tree = await loading;
  assert.equal(tree.type,'LeaveDemo');
  assert.deepEqual(tree.props.actorCapabilities,row);
  assert.equal(tree.props.authActorId,actorId);
  assert.equal(tree.props.canViewSubscriptionReviewCalendar,true);
  assert.deepEqual(tree.props.initialNavigation,{view:'leave',section:'balance',requestId:undefined,peopleSection:undefined});
  assert.equal(h.authCalls(),1);
});

test('server page does not read capabilities before a verified authenticated user', async () => {
  const unconfigured = homeFixture({configured:false});
  assert.equal((await unconfigured.load()).type,'RolePermissionRecovery');
  assert.equal(unconfigured.authCalls(),0);
  assert.deepEqual(unconfigured.calls,[]);
  for (const options of [{user:null},{authError:{message:'Synthetic auth denial'}},{user:null,authError:{status:401}}]) {
    const h = homeFixture(options);
    await assert.rejects(h.load(),/redirect:\/login/);
    assert.equal(h.authCalls(),1);
    assert.deepEqual(h.calls,[]);
  }
  const transport = homeFixture({authThrows:true});
  await assert.rejects(transport.load(),/Synthetic auth transport failure/);
  assert.equal(transport.authCalls(),1);
  assert.deepEqual(transport.calls,[]);
});

test('server page uses the real closed role parser and fails closed on malformed or failed canonical reads', async () => {
  const row = capabilities('account');
  for (const data of [null,[],[row,row],[{...row,app_role:'owner'}],[{...row,person_id:null}],[{...row,account_status:'disabled'}],[{...row,can_manage_roles:'true'}]]) {
    const h = homeFixture({rpc:async name => ({data:name === 'get_portal_role_capabilities' ? data : true,error:null,status:200})});
    assert.equal((await h.load()).type,'RolePermissionRecovery');
    assert.equal(h.authCalls(),1);
  }
  for (const result of [{data:[row],error:{code:'42501'}},{data:[row],error:null,status:500}]) {
    const h = homeFixture({rpc:async name => name === 'get_portal_role_capabilities' ? result : {data:true,error:null,status:200}});
    assert.equal((await h.load()).type,'RolePermissionRecovery');
  }
  const transport = homeFixture({rpc:async name => {
    if (name === 'get_portal_role_capabilities') throw new Error('Synthetic role transport failure');
    return {data:true,error:null,status:200};
  }});
  assert.equal((await transport.load()).type,'RolePermissionRecovery');
});

test('server page grants the optional calendar only for an explicit successful true result', async () => {
  for (const result of [{data:false,error:null},{data:null,error:null},{data:'true',error:null},{data:true,error:{code:'42501'}},{data:true,error:null,status:503}]) {
    const h = homeFixture({rpc:async name => name === 'get_portal_role_capabilities' ? {data:[capabilities('account')],error:null,status:200} : result});
    const tree = await h.load();
    assert.equal(tree.type,'LeaveDemo');
    assert.equal(tree.props.canViewSubscriptionReviewCalendar,false);
  }
  const transport = homeFixture({rpc:async name => {
    if (name === 'can_view_subscription_review_calendar') throw new Error('Synthetic calendar transport failure');
    return {data:[capabilities('account')],error:null,status:200};
  }});
  assert.equal((await transport.load()).type,'RolePermissionRecovery');
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
