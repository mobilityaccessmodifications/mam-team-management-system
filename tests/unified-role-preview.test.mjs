import assert from 'node:assert/strict';
import * as React from 'react';
import test from 'node:test';
import { actionFixture, capabilities, deferred, flush, hooksHarness, loadModule, nodes, targetId, text } from './helpers/unified-role-harness.mjs';
const secondId = '11000000-0000-4000-8000-000000000003';
const component = (tree,name) => nodes(tree).find(node => node.type === name || node.type?.name === name);
function portal({ contactFailure = false, capabilityResult, targetRole = 'admin', decision, workspace, grants = {}, scheduleMutation, organisationMutation, organisationLoad, accountsLoad, contactMutation } = {}) {
  const hooks = hooksHarness(React), timers = new Map(), calls = [];
  let timerId = 0, role = targetRole;
  globalThis.window = { setTimeout(fn,delay) { const id = ++timerId; if (delay < 1000) timers.set(id,fn); return id; }, clearTimeout(id) { timers.delete(id); }, setInterval() {}, clearInterval() {}, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }), scrollTo() {} };
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, getElementById: () => null };
  const rows = [targetId,secondId].map((id,index) => ({ id, node_kind:'person',company_key:'mam',full_name:'Synthetic '+(index ? 'B' : 'A'),position_title:'Tester',parent_id:null,is_active:true,sort_order:index,version:1 }));
  const client = { from() { calls.push(['organisation-read']); const q = { select: () => q, order: () => q, then: (done) => Promise.resolve(organisationLoad ? organisationLoad(rows) : { data:rows,error:null }).then(done) }; return q; }, rpc: async (name,args) => { if (name==='create_internal_org_node') { calls.push(['organisation-mutation',args]); return await organisationMutation?.promise ?? {data:true,error:null}; } return { data:true,error:null }; }, channel() { const c = { on: () => c, subscribe: () => c }; return c; }, removeChannel() {} };
  const baseWorkspace = id => ({ requests: [],attachments: [],calendarEntries:[],birthdayEntries:[],checkInEntries:[],subscriptionReviewEntries:[],payrollBalanceReminderEntries:[],canViewSubscriptionReviewCalendar:false,canViewPayrollBalanceReminderCalendar:false,canImportPayrollBalances:role==='account'||role==='admin',canReviewLeave:role==='manager'||role==='admin',canViewAllLeave:role==='account'||role==='admin',employmentType:'full_time',hasPaidLeaveEntitlement:true,availableLeaveTypes: ['Annual leave'],isProfilePreview:Boolean(id),priority:{ people:[],canManageBalances:role==='admin' } });
  const overrides = {
    '@/app/login/actions': {}, '@/app/assets/employee-actions': {}, '@/app/subscriptions/employee-actions': {},
    react: hooks.react, 'next/link': 'link', 'next/dynamic': callback => callback.toString().match(/module\.(\w+)/)?.[1] ?? 'Dynamic',
    '@/lib/supabase/client': { createClient: () => client }, '@/lib/supabase/config': { isSupabaseConfigured: () => true },
    '@/app/roles/actions': { getPortalRoleCapabilities: async id => { calls.push(['capabilities',id]); if (capabilityResult) return await capabilityResult(); return { ok:true,capabilities:{...capabilities(id ? role : 'system_admin',id ?? null),...grants} }; } },
    '@/app/profile/actions': {updateSelectedEmployeeProfile:async input=>{calls.push(['contact-mutation',input]);if(contactMutation)return await contactMutation.promise;return {personId:input.personId,name:'Synthetic A',title:'Tester',company:'mam',detailVersion:2};}, getSelectedEmployeeProfile: async id => { if (contactFailure) { const f = actionFixture({ contactError:{ message:'private synthetic contact failure' } }); return f.load('src/app/profile/actions.ts').getSelectedEmployeeProfile(id); } return { personId:id,name:'Synthetic A',title:'Tester',company:'mam',detailVersion:1 }; } },
    '@/app/people/actions': {getOrganisationPersonWorkEmail:async()=>null},
    '@/app/accounts/actions': { listPortalAccounts: async () => { calls.push(['accounts']); return accountsLoad ? await accountsLoad() : []; } },
    '@/app/work-schedule/actions': { requestEmployeeWorkScheduleChange:async input=>{calls.push(['schedule-mutation',input]);return await scheduleMutation?.promise ?? {ok:true};}, reviewEmployeeWorkScheduleChange:async input=>{calls.push(['schedule-review',input]);return {ok:true};}, loadEmployeeWorkScheduleWorkspace: async id => { calls.push(['schedule',id]); return {ok:true,workspace:{activePersonId:id ?? null,isProfilePreview:Boolean(id)}}; } },
    '@/app/leave/actions': { getLeaveWorkspaceData: async id => { calls.push(['leave',id]); return {...baseWorkspace(id),...workspace?.(id)}; }, decideLeaveRequest: async () => typeof decision === 'function' ? await decision() : await decision?.promise },
  };
  for (const name of ['brand-mark','leave-priority-controls','check-in-register','check-in-workspace','check-in-tasks','work-schedule-workflow','self-profile-menu','leave-attachment-list','leave-request-dialog']) overrides['@/components/'+name] = new Proxy({}, { get: (_,key) => key });
  overrides['@/components/ui/use-dialog-focus'] = { useDialogFocus() {} };
  const mod = loadModule('src/components/leave-demo.tsx', overrides);
  const props = { actorCapabilities:capabilities('system_admin',null),isAdmin:true,isNonRosterSystemAdmin:true,canViewEmployeeDirectory:true,canViewOrganisation:true,canChangeEmployeeView:true,canViewSubscriptions:true,canManageSubscriptions:true,canManageSubscriptionCredentials:true,canManageSubscriptionCredentialGrants:true,canManageAnalyticsApi:true,canViewTeamCalendar:true,checkInResources:{canApproveEmploymentDecisions:true} };
  let tree;
  const render = () => { hooks.begin(); tree = mod.LeaveDemo(props); hooks.effects(); return tree; };
  return {
    calls, props, render,
    setRole(value) { role = value; },
    async settle() { for (let i=0;i<6;i++) { render(); for (const [id,fn] of [...timers]) { timers.delete(id); fn(); } await flush(); } return render(); },
    select(id) { let t = render(); nodes(t).find(n => n.type==='button' && /Change profile/.test(n.props['aria-label'] ?? '')).props.onClick(); t = render(); nodes(t).find(n => n.type==='button' && String(n.props.className).includes('profilePickerOption') && text(n).includes(id === secondId ? 'Synthetic B' : 'Synthetic A')).props.onClick(); return render(); },
  };
}
for(const returnToA of [false,true]) test(`late selected save rejects rather than fulfilling after generation change returnToA=${returnToA}`,async()=>{
  const contactMutation=deferred(),ui=portal({contactMutation});await ui.settle();ui.select(targetId);let tree=await ui.settle();
  const saving=component(tree,'SelfProfileMenu').props.onSave({phone:'synthetic draft'});
  const rejected=assert.rejects(saving,/active profile changed/);
  ui.select(secondId);await ui.settle();if(returnToA){ui.select(targetId);await ui.settle();}
  const before=ui.calls.length;contactMutation.resolve({personId:targetId,name:'Synthetic A',title:'Tester',company:'mam',detailVersion:2});await rejected;
  assert.equal(ui.calls.length,before);
});
for(const callback of ['select','open']) test(`old HR directory ${callback} callback cannot overwrite the current selected record`,async()=>{
  const ui=portal();await ui.settle();ui.select(targetId);let tree=await ui.settle();
  const people=component(tree,'PeopleOperationsDemo').props,oldSelect=people.renderEmployeeDirectory.props.onSelectedPersonId,oldOpen=people.onOpenEmployeeDirectoryRecord;
  ui.select(secondId);tree=await ui.settle();component(tree,'PeopleOperationsDemo').props.renderEmployeeDirectory.props.onSelectedPersonId(secondId);
  (callback==='select'?oldSelect:oldOpen)(targetId);tree=ui.render();
  assert.equal(component(tree,'PeopleOperationsDemo').props.renderEmployeeDirectory.props.selectedPersonId,secondId);
});
test('directory epoch invalidation releases owned busy state while late decision cannot clear a new decision',async()=>{
  const decision=deferred(),newDecision=deferred();let decisions=0;
  const workspace=id=>({requests:[{id:id+'-request',personId:id,employee:'Synthetic',company:'mam',leaveType:'Annual leave',startDate:'2026-10-12',endDate:'2026-10-12',days:1,status:'Pending',submittedAt:'2026-10-01T00:00:00Z',canDecide:true}]});
  const ui=portal({decision:()=>++decisions===1?decision.promise:newDecision.promise,workspace});await ui.settle();ui.select(targetId);let tree=await ui.settle();
  const invalidate=component(tree,'PeopleOperationsDemo').props.renderEmployeeDirectory.props.onRecordsChanged;
  component(tree,'HomeView').props.onNavigate('leave','approvals');tree=ui.render();const saving=component(tree,'LeaveView').props.onDecision('Approved');
  assert.equal(component(ui.render(),'LeaveView').props.busy,true);await invalidate();tree=await ui.settle();
  assert.equal(component(tree,'LeaveView').props.busy,false);
  const newer=component(tree,'LeaveView').props.onDecision('Approved');assert.equal(component(ui.render(),'LeaveView').props.busy,true);
  decision.resolve({id:targetId+'-request'});await saving;assert.equal(component(ui.render(),'LeaveView').props.busy,true);
  newDecision.resolve({id:targetId+'-request'});await newer;assert.equal(component(ui.render(),'LeaveView').props.busy,false);
});
test('removing the active directory profile releases its pending mutation state on return to P0',async()=>{
  const decision=deferred();let removed=false;
  const workspace=id=>({requests:[{id:String(id)+'-request',personId:id,employee:'Synthetic',company:'mam',leaveType:'Annual leave',startDate:'2026-10-12',endDate:'2026-10-12',days:1,status:'Pending',submittedAt:'2026-10-01T00:00:00Z',canDecide:true}]});
  const ui=portal({targetRole:'manager',decision,workspace,organisationLoad:rows=>({data:removed?rows.filter(row=>row.id!==targetId):rows,error:null})});
  await ui.settle();ui.select(targetId);let tree=await ui.settle();const reload=component(tree,'PeopleOperationsDemo').props.renderEmployeeDirectory.props.onRecordsChanged;
  component(tree,'HomeView').props.onNavigate('leave','approvals');tree=ui.render();const saving=component(tree,'LeaveView').props.onDecision('Approved');
  removed=true;await reload();tree=await ui.settle();assert.equal(component(tree,'PeopleOperationsDemo').props.activeProfile.accessRole,'system_admin');
  component(tree,'HomeView').props.onNavigate('leave','approvals');tree=ui.render();assert.equal(component(tree,'LeaveView').props.busy,false);
  decision.resolve({id:targetId+'-request'});await saving;assert.equal(component(ui.render(),'LeaveView').props.busy,false);
});
test('promoted Admin preview loads every operational panel independently of private contact failure', async () => {
  const ui = portal({ contactFailure:true }); await ui.settle(); ui.select(targetId); const tree = await ui.settle();
  const people = component(tree,'PeopleOperationsDemo')?.props;
  assert.ok(people?.renderEmployeeDirectory, 'promoted Admin directory');
  assert.ok(people.renderAssetRegister, 'promoted Admin assets');
  assert.ok(people.renderAccounts, 'promoted Admin accounts');
  assert.equal(people.activeProfile.accessRole,'admin');
  assert.ok(!people.renderAnalyticsApiManagement,'P0 security never follows target');
  assert.equal(people.renderEmployeeDirectory.props.canManageRoles,false);
  assert.equal(people.renderSubscriptionRegister.props.canManageCredentialGrants,false);
  assert.match(text(tree),/Employee profile could not be loaded/);
});
test('capability failure withholds privileged panels and exposes a sanitized retry, not employee fallback', async () => {
  const ui = portal({ capabilityResult:async () => ({ok:false,error:'Role permissions could not be loaded. Retry before using this profile.'}) }); await ui.settle(); ui.select(targetId); const tree = await ui.settle();
  assert.match(text(tree),/Role permissions could not be loaded/);
  const people = component(tree,'PeopleOperationsDemo')?.props;
  assert.ok(!people || !people.renderAccounts && !people.renderEmployeeDirectory && !people.renderSubscriptionRegister);
  assert.ok(nodes(tree).some(n => n.type==='button' && text(n)==='Retry permissions'));
});
test('same-target reselect reloads promoted capabilities; pending transition clears prior panels', async () => {
  const ui = portal({ targetRole:'employee' }); await ui.settle(); ui.select(targetId); await ui.settle();
  ui.setRole('admin'); const pending = ui.select(targetId);
  const people = component(pending,'PeopleOperationsDemo')?.props;
  assert.ok(!people?.renderAccounts);
  const tree = await ui.settle(); assert.ok(component(tree,'PeopleOperationsDemo').props.renderAssetRegister);
  assert.equal(ui.calls.filter(([name,id]) => name==='capabilities' && id===targetId).length,2);
});
test('late A leave decision cannot replace B selection, clear B busy state or start an A refresh', async () => {
  const decision = deferred();
  const workspace = id => ({requests:[{id:id+'-request',personId:id,employee:id===secondId?'Synthetic B':'Synthetic A',company:'mam',leaveType:'Annual leave',startDate:'2026-10-12',endDate:'2026-10-12',days:1,status:'Pending',submittedAt:'2026-10-01T00:00:00Z',canDecide:true,canCancel:false,canAttach:false}]});
  const ui = portal({targetRole:'manager',decision,workspace}); await ui.settle(); ui.select(targetId); let tree = await ui.settle();
  component(tree,'HomeView').props.onNavigate('leave','approvals'); tree = ui.render();
  const saving = component(tree,'LeaveView').props.onDecision('Approved');
  ui.select(secondId); tree = await ui.settle();
  component(tree,'HomeView').props.onNavigate('leave','approvals'); tree = ui.render();
  const before = ui.calls.filter(([name])=>name==='leave').length;
  decision.resolve({id:targetId+'-request'}); await saving; tree = ui.render();
  assert.equal(component(tree,'LeaveView').props.selectedId,secondId+'-request');
  assert.equal(ui.calls.filter(([name])=>name==='leave').length,before);
  assert.doesNotMatch(text(tree),/Leave request was approved/);
});
test('Admin preview retains manual balance management while Account cannot inherit stale balance authority',async()=>{
  for(const role of ['admin','account']){
    const ui=portal({targetRole:role,workspace:()=>({priority:{canManageBalances:true,people:[]}})});
    await ui.settle();ui.select(targetId);let tree=await ui.settle();
    component(tree,'HomeView').props.onNavigate('leave','balance');tree=ui.render();
    const controls=component(component(tree,'LeaveView').props.balanceContent,'LeavePriorityControls');
    assert.equal(Boolean(controls),role==='admin');
  }
});
test('Account preview uses comparison-only payroll and no other-owner write controls', async () => {
  const ui = portal({targetRole:'account'}); await ui.settle(); ui.select(targetId); let tree = await ui.settle();
  const people = component(tree,'PeopleOperationsDemo').props;
  assert.equal(people.activeProfile.accessRole,'account');
  assert.equal(people.renderEmployeeDirectory.type,'EmployeeTeamDirectory');
  assert.equal(people.renderCheckInTasks().props.previewPersonId,targetId);
  assert.ok(!people.renderAccounts && !people.renderAssetRegister && !people.renderSubscriptionRegister);
  component(tree,'HomeView').props.onNavigate('leave','balance'); tree = ui.render();
  const leave = component(tree,'LeaveView').props;
  assert.equal(leave.canReview,false); assert.equal(leave.canViewAllLeave,true);
  const importer = component(leave.balanceContent,'PayrollBalanceImporter');
  assert.equal(importer.props.comparisonOnly,true);
  assert.equal(importer.props.previewPersonId,targetId);
});
test('an old selected-contact save cannot dispatch after selecting a different profile',async()=>{
  const ui=portal();await ui.settle();ui.select(targetId);let tree=await ui.settle();
  const save=component(tree,'SelfProfileMenu').props.onSave;
  ui.select(secondId);await ui.settle();
  await assert.rejects(save({phone:'synthetic'}),/active profile changed/);
  assert.equal(ui.calls.filter(([name])=>name==='contact-mutation').length,0);
});
test('operational Admin and Manager check-in previews retain target-authorized controls',async()=>{
  for(const role of ['admin','manager']){
    const ui=portal({targetRole:role});await ui.settle();ui.select(targetId);const tree=await ui.settle();
    const checkIns=component(tree,'PeopleOperationsDemo').props.renderCheckInRegister;
    assert.equal(checkIns.props.readOnly,false);
  }
});
test('Manager check-in controls do not inherit P0 employment decisions',async()=>{
  const ui=portal({targetRole:'manager'});await ui.settle();ui.select(targetId);const tree=await ui.settle();
  const checkIns=component(tree,'PeopleOperationsDemo').props.renderCheckInRegister;
  assert.equal(checkIns.props.resources.canApproveEmploymentDecisions,false);
});
test('Team member and Account keep their own target-scoped check-in tasks',async()=>{
  for(const role of ['employee','account']){
    const ui=portal({targetRole:role});await ui.settle();ui.select(targetId);const tree=await ui.settle();
    const tasks=component(tree,'PeopleOperationsDemo').props.renderCheckInTasks();
    assert.equal(tasks.props.previewPersonId,targetId);
    assert.equal(tasks.props.showCheckInTasks,true);
  }
});
test('an old A work-schedule callback cannot dispatch after B becomes active',async()=>{
  const ui=portal({targetRole:'manager'});await ui.settle();ui.select(targetId);let tree=await ui.settle();
  const oldRequest=component(tree,'HomeView').props.workSchedule.props.onRequest;
  ui.select(secondId);await ui.settle();
  const result=await oldRequest(['monday'],[],'synthetic change');
  assert.equal(result.ok,false);
  assert.equal(ui.calls.filter(([name])=>name==='schedule-mutation').length,0);
});
for (const returnToA of [false, true]) test(`retired payroll completion cannot dispatch or replace the current leave scope returnToA=${returnToA}`, async () => {
  const workspace = id => ({ requests: [{ id:id+'-request',personId:id,employee:'Synthetic',company:'mam',leaveType:'Annual leave',startDate:'2026-10-12',endDate:'2026-10-12',days:1,status:'Pending',submittedAt:'2026-10-01T00:00:00Z',canDecide:true }] });
  const ui = portal({ workspace }); await ui.settle(); ui.select(targetId); let tree = await ui.settle();
  component(tree,'HomeView').props.onNavigate('leave','balance'); tree=ui.render();
  const retired = component(component(tree,'LeaveView').props.balanceContent,'PayrollBalanceImporter').props.onSaved;
  ui.select(secondId); await ui.settle(); if (returnToA) { ui.select(targetId); await ui.settle(); }
  const before=ui.calls.length; await retired(); tree=ui.render();
  assert.equal(ui.calls.length,before,'retired callback must not start a read or claim current load ownership');
  const expected=returnToA?targetId:secondId;
  assert.equal(component(tree,'PeopleOperationsDemo').props.activeProfile.id,expected);
  component(tree,'HomeView').props.onNavigate('leave','requests'); tree=ui.render();
  assert.deepEqual(component(tree,'LeaveView').props.requests.map(r=>r.personId),[expected]);
  await component(tree,'LeaveView').props.onBalancesSaved();
  assert.deepEqual(ui.calls.slice(before).filter(([name])=>name==='leave'),[['leave',expected]],'current completion still refreshes its own scope');
});
test('retired work-schedule refresh cannot start an A read after B selection',async()=>{
  const ui=portal(); await ui.settle(); ui.select(targetId); let tree=await ui.settle();
  const retired=component(tree,'HomeView').props.workSchedule.props.onRefresh;
  ui.select(secondId); await ui.settle(); const before=ui.calls.length;
  await retired(); assert.equal(ui.calls.length,before);
  await component(ui.render(),'HomeView').props.workSchedule.props.onRefresh();
  assert.deepEqual(ui.calls.slice(before).filter(([name])=>name==='schedule'),[['schedule',secondId]]);
});
for (const switchProfile of [false,true]) test(`organisation update completion retains its post-refresh scope switchProfile=${switchProfile}`,async()=>{
  const pending=deferred(); let blockNext=false,heldRows=[];
  const ui=portal({organisationLoad:rows=>{if(blockNext){blockNext=false;heldRows=rows;return pending.promise;}return {data:rows,error:null};}});
  await ui.settle(); ui.select(targetId); const tree=await ui.settle(); blockNext=true;
  const updating=component(tree,'PeopleOperationsDemo').props.onUpdateOrganisationPerson(targetId,{company:'mam',position:'Tester',name:'Synthetic A Renamed',reportsTo:null,expectedVersion:1});
  await flush(); if(switchProfile){ui.select(secondId);await ui.settle();}
  pending.resolve({data:heldRows,error:null}); await updating;
  const latest=ui.render();
  assert.equal(component(latest,'PeopleOperationsDemo').props.activeProfile.id,switchProfile?secondId:targetId);
  if(switchProfile) assert.doesNotMatch(text(latest),/Synthetic A Renamed's profile was updated\./);
  else assert.match(text(latest),/Synthetic A Renamed's profile was updated\./);
});
test('a late A organisation mutation cannot announce or refresh into B',async()=>{
  const mutation=deferred();const ui=portal({organisationMutation:mutation});await ui.settle();ui.select(targetId);let tree=await ui.settle();
  const saving=component(tree,'PeopleOperationsDemo').props.onCreateOrganisationPerson({company:'mam',position:'Tester',name:'Synthetic New',reportsTo:null});
  ui.select(secondId);await ui.settle();const before=ui.calls.length;
  mutation.resolve({data:true,error:null});await saving;tree=ui.render();
  assert.equal(ui.calls.length,before);
  assert.doesNotMatch(text(tree),/Synthetic New added/);
});
test('an old Accounts retry cannot clear B account data or change its load state',async()=>{
  let fail=false;
  const account={userId:'11000000-0000-4000-8000-000000000004',personId:secondId,fullName:'Synthetic B',loginName:'synthetic-b@example.test',accountStatus:'active'};
  const ui=portal({accountsLoad:async()=>{if(fail)throw new Error('Synthetic account load failure');return [account];}});
  await ui.settle();fail=true;ui.select(targetId);let tree=await ui.settle();
  const retry=nodes(component(tree,'PeopleOperationsDemo').props.renderAccounts).find(n=>n.type==='button' && text(n)==='Retry accounts');
  fail=false;ui.select(secondId);tree=await ui.settle();
  assert.deepEqual(component(tree,'PeopleOperationsDemo').props.renderAccounts.props.accounts,[account]);
  const before=ui.calls.filter(([name])=>name==='accounts').length;
  retry.props.onClick();await flush();tree=ui.render();
  assert.deepEqual(component(tree,'PeopleOperationsDemo').props.renderAccounts.props.accounts,[account]);
  assert.equal(ui.calls.filter(([name])=>name==='accounts').length,before);
});
test('an old Manager directory callback cannot start an A organisation read after B selection',async()=>{
  const ui=portal({targetRole:'manager'});await ui.settle();ui.select(targetId);const tree=await ui.settle();
  const reload=component(tree,'PeopleOperationsDemo').props.renderEmployeeDirectory.props.onRecordsChanged;
  ui.select(secondId);await ui.settle();const before=ui.calls.filter(([name])=>name==='organisation-read').length;
  await reload();
  assert.equal(ui.calls.filter(([name])=>name==='organisation-read').length,before);
});
test('a late A organisation read cannot remove B and silently return to P0 authority',async()=>{
  const pending=deferred();let blockNext=false;
  const ui=portal({targetRole:'manager',organisationLoad:rows=>{
    if(blockNext){blockNext=false;return pending.promise;}
    return {data:rows,error:null};
  }});
  await ui.settle();ui.select(targetId);let tree=await ui.settle();
  blockNext=true;
  const reading=component(tree,'PeopleOperationsDemo').props.renderEmployeeDirectory.props.onRecordsChanged();
  await flush();ui.select(secondId);await ui.settle();
  pending.resolve({data:[{id:targetId,node_kind:'person',company_key:'mam',full_name:'Synthetic A',position_title:'Tester',parent_id:null,is_active:true,sort_order:0,version:1}],error:null});
  await reading;tree=await ui.settle();
  const people=component(tree,'PeopleOperationsDemo').props;
  assert.equal(people.activeProfile.id,secondId);
  assert.equal(people.activeProfile.accessRole,'manager');
  assert.ok(!people.renderAnalyticsApiManagement);
});
test('Manager subscription register management and vault capabilities stay independent in preview', async () => {
  for (const management of [false,true]) for (const vault of [false,true]) {
    const ui = portal({targetRole:'manager',grants:{can_manage_subscriptions:management,can_manage_subscription_credentials:vault}});
    await ui.settle(); ui.select(targetId); const tree = await ui.settle();
    const panel = component(tree,'PeopleOperationsDemo').props.renderSubscriptionRegister;
    assert.equal(panel.props.readOnly,!management);
    assert.equal(panel.props.canManageCredentials,vault);
    assert.equal(panel.props.canManageCredentialGrants,false);
    assert.equal(panel.props.canManageManagementGrants,false);
  }
});
test('Employee subscription preview uses only its independent grants, never P0 actor authority', async () => {
  for (const management of [false,true]) for (const vault of [false,true]) {
    const ui = portal({targetRole:'employee',grants:{can_view_subscription_register:management,can_manage_subscriptions:management,can_manage_subscription_credentials:vault}});
    await ui.settle(); ui.select(targetId); const tree = await ui.settle();
    const people = component(tree,'PeopleOperationsDemo').props;
    assert.equal(people.activeProfile.accessRole,'employee');
    const panel = people.renderSubscriptionRegister;
    assert.equal(Boolean(panel),management || vault);
    if (management) {
      assert.equal(panel.props.readOnly,false);
      assert.equal(panel.props.canManageCredentials,vault);
      assert.equal(panel.props.canManageCredentialGrants,false);
      assert.equal(panel.props.canManageManagementGrants,false);
    } else if (vault) {
      assert.equal(panel.type,'SubscriptionCredentialVault');
      assert.equal(panel.props.canManageCredentialGrants,false);
      assert.equal(panel.props.canManageManagementGrants,undefined);
    }
    assert.ok(!people.renderAccounts && !people.renderAssetRegister && !people.renderAnalyticsApiManagement);
  }
});
test('late Employee delegation capabilities cannot grant the newer selected Employee access', async () => {
  const old = deferred();
  let ui;
  ui = portal({targetRole:'employee',capabilityResult:async () => {
    const id = ui.calls.filter(([name])=>name==='capabilities').at(-1)[1];
    if (id===targetId) return await old.promise;
    return {ok:true,capabilities:capabilities(id ? 'employee' : 'system_admin',id ?? null)};
  }});
  await ui.settle();ui.select(targetId);await ui.settle();
  ui.select(secondId);let tree=await ui.settle();
  assert.ok(!component(tree,'PeopleOperationsDemo').props.renderSubscriptionRegister);
  old.resolve({ok:true,capabilities:{...capabilities('employee',targetId),can_view_subscription_register:true,can_manage_subscriptions:true,can_manage_subscription_credentials:true}});
  tree=await ui.settle();
  const people=component(tree,'PeopleOperationsDemo').props;
  assert.equal(people.activeProfile.id,secondId);
  assert.equal(people.activeProfile.accessRole,'employee');
  assert.ok(!people.renderSubscriptionRegister && !people.renderAccounts && !people.renderAnalyticsApiManagement);
});
