import assert from 'node:assert/strict';
import * as React from 'react';
import test from 'node:test';
import { actionFixture, capabilities, hooksHarness, loadModule, nodes, targetId, text, flush } from './helpers/unified-role-harness.mjs';
const batchId = '12000000-0000-4000-8000-000000000001';
const fullBatch = comparisonOnly => ({batchId,status:'staged',version:1,comparisonOnly,createdAt:'2026-10-01T00:00:00Z',differenceCount:0,comparisonRows:[],files:[{name:'payroll.csv',sizeBytes:10,employeeRows:1,companies:['mam'],asOfDates:['2026-10-01']}],rows:[{rowId:1,employeeName:'Synthetic Target',company:'mam',asOf:'2026-10-01',status:'linked',willApplyAnnual:false,willApplySick:false}]});
const loadError = 'Payroll balance import could not be loaded. Refresh and try again.';
const previewWorkspace = batches => ({
  canImport: true, canManageAccess: false, comparisonOnly: false, canManageBalances: true,
  reminder: {dueOn:'2026-10-01',mamAsOf:null,equipsyAsOf:null,mamComplete:false,equipsyComplete:false,complete:false},
  recentBatches: batches.map(batch => ({...batch,rowCount:batch.rows.length})),
});
function payrollActionFixture({target = capabilities(), actor = capabilities('system_admin',null), workspace = {data:previewWorkspace([]),error:null}, batch = {data:fullBatch(false),error:null}} = {}) {
  const f = actionFixture({target,actor});
  const rpc = f.client.rpc;
  f.client.rpc = async (name,args) => {
    if (['get_payroll_balance_import_workspace_for_preview','get_payroll_balance_import_batch','commit_payroll_balance_import'].includes(name)) {
      f.calls.push({name,args});
      const result = name === 'get_payroll_balance_import_workspace_for_preview' ? workspace : batch;
      if (result instanceof Error) throw result;
      return result;
    }
    return rpc(name,args);
  };
  return {...f,actions:loadModule('src/app/payroll-balances/actions.ts',{
    ...f.overrides,'@/lib/payroll-balance-import':{},'@/lib/payroll-balance-source-archive':{},
    '@/lib/supabase/admin':{createAdminClient(){assert.fail('batch access must retain the authenticated client');}},
  })};
}
test('preview batch read denies foreign-target membership before actor-wide detail reads',async()=>{
  const f = payrollActionFixture({target:capabilities('account'),batch:{data:fullBatch(true),error:null}});
  await assert.rejects(f.actions.getPayrollBalanceImportBatch(batchId,targetId),{message:loadError});
  assert.ok(f.calls.some(call=>call.name==='get_payroll_balance_import_workspace_for_preview' && call.args.p_person_id===targetId));
  assert.ok(!f.calls.some(call=>call.name==='get_payroll_balance_import_batch'));
});
test('preview payroll commit denies foreign-target membership before any balance-write RPC',async()=>{
  const f = payrollActionFixture();
  const result = await f.actions.commitPayrollBalanceImport(batchId,1,targetId);
  assert.equal(result.ok,false);
  assert.equal(result.message,loadError);
  assert.ok(f.calls.some(call=>call.name==='get_payroll_balance_import_workspace_for_preview' && call.args.p_person_id===targetId));
  assert.ok(!f.calls.some(call=>call.name==='commit_payroll_balance_import'));
});
test('preview payroll commit denies a target that lost balance-write authority in the scoped DB projection',async()=>{
  const f = payrollActionFixture({workspace:{data:{...previewWorkspace([fullBatch(false)]),comparisonOnly:true,canManageBalances:false},error:null}});
  assert.deepEqual(await f.actions.commitPayrollBalanceImport(batchId,1,targetId),{ok:false,message:loadError});
  assert.ok(!f.calls.some(call=>call.name==='commit_payroll_balance_import'));
});
for (const operation of ['detail','commit']) test(`preview batch ${operation} RPC transport failures remain generic after scope approval`,async()=>{
  const f = payrollActionFixture({workspace:{data:previewWorkspace([fullBatch(false)]),error:null},batch:new Error('Synthetic provider failure')});
  if (operation==='detail') await assert.rejects(f.actions.getPayrollBalanceImportBatch(batchId,targetId),{message:loadError});
  else assert.deepEqual(await f.actions.commitPayrollBalanceImport(batchId,1,targetId),{ok:false,message:loadError});
});
test('preview batch read rejects a foreign batch payload even after the requested id passed scoped membership',async()=>{
  const f = payrollActionFixture({workspace:{data:previewWorkspace([fullBatch(false)]),error:null},batch:{data:{...fullBatch(false),batchId:'12000000-0000-4000-8000-000000000002'},error:null}});
  await assert.rejects(f.actions.getPayrollBalanceImportBatch(batchId,targetId),{message:loadError});
});
test('preview upload uses the deployed service RPC contract and real P0 uploader, not target Auth',async()=>{
  const f=actionFixture({target:capabilities('account')}),events=[];
  const mod=loadModule('src/app/payroll-balances/actions.ts',{
    ...f.overrides,
    '@/lib/payroll-balance-import':{preparePayrollBalanceFiles:async files=>files,parsePreparedPayrollBalanceFiles:async()=>({sourceDigest:'a'.repeat(64),files:[],rows:[]})},
    '@/lib/payroll-balance-source-archive':{archivePayrollBalanceFiles:async actor=>{events.push(['archive',actor]);return ['synthetic-archive'];},linkPayrollBalanceSourceArchives:async actor=>events.push(['link',actor])},
    '@/lib/supabase/admin':{createAdminClient:()=>({rpc:async(name,args)=>{events.push([name,args]);return {data:fullBatch(true),error:null};}})},
  });
  const form=new FormData();form.append('files',new File(['synthetic'],'payroll.csv'));
  assert.equal((await mod.stagePayrollBalanceFiles(form,targetId)).ok,true);
  const staged=events.find(([name])=>name==='stage_payroll_balance_import_for_preview');
  assert.equal(staged[1].p_person_id,targetId);
  assert.equal(staged[1].p_actor_user_id,'11000000-0000-4000-8000-000000000001');
  assert.equal(events[0][0],'archive');
  assert.ok(!Object.hasOwn(staged[1],'p_preview_person_id'));
});
test('Admin preview retains operational payroll commit after actor and target reauthorization',async()=>{
  const f=payrollActionFixture({workspace:{data:previewWorkspace([fullBatch(false)]),error:null}});
  assert.equal((await f.actions.commitPayrollBalanceImport(batchId,1,targetId)).ok,true);
  assert.deepEqual(f.calls.filter(call=>call.name.startsWith('get_payroll_balance_import_workspace') || call.name==='commit_payroll_balance_import'),[
    {name:'get_payroll_balance_import_workspace_for_preview',args:{p_person_id:targetId}},
    {name:'commit_payroll_balance_import',args:{p_batch_id:batchId,p_expected_version:1}},
  ]);
});
test('preview payroll workspace loads only the target projection and its own recent batches', async () => {
  const f = actionFixture({target:capabilities('account')});
  const rpc = f.client.rpc;
  f.client.rpc = async (name,args) => {
    if (name === 'get_payroll_balance_import_workspace_for_preview') {
      f.calls.push({name,args});
      return {data:{canImport:true,canManageAccess:true,comparisonOnly:true,canManageBalances:false,reminder:{dueOn:'2026-10-01',mamAsOf:null,equipsyAsOf:null,mamComplete:false,equipsyComplete:false,complete:false},recentBatches:[{...fullBatch(true),rowCount:1}]},error:null};
    }
    return rpc(name,args);
  };
  const mod = loadModule('src/app/payroll-balances/actions.ts',{...f.overrides,'@/lib/payroll-balance-import':{},'@/lib/payroll-balance-source-archive':{},'@/lib/supabase/admin':{}});
  const result = await mod.getPayrollBalanceImportWorkspace(targetId);
  assert.equal(result.status,'ready');
  assert.equal(result.workspace.canManageAccess,false);
  assert.equal(result.workspace.recentBatches[0].batchId,batchId);
  assert.ok(f.calls.some(call=>call.name==='get_payroll_balance_import_workspace_for_preview' && call.args.p_person_id===targetId));
  assert.ok(!f.calls.some(call=>call.name==='get_payroll_balance_import_workspace'));
});
test('Account commit is rejected by the real action before any balance-write RPC even with importer access', async () => {
  const f = actionFixture({actor:capabilities('account')});
  const original=f.client.rpc;
  f.client.rpc=async(name,args)=>name==='can_import_payroll_balances'?{data:true,error:null}:original(name,args);
  const mod=loadModule('src/app/payroll-balances/actions.ts',{
    ...f.overrides, '@/lib/payroll-balance-import':{}, '@/lib/payroll-balance-source-archive':{},'@/lib/supabase/admin':{createAdminClient(){assert.fail('commit must retain authenticated client');}},
  });
  const result=await mod.commitPayrollBalanceImport(batchId,1);
  assert.deepEqual(result,{ok:false,message:'Comparison-only access cannot apply payroll balances.'});
  assert.ok(!f.calls.some(call=>call.name==='commit_payroll_balance_import'));
});
test('Account preview importer passes its target on reads/uploads and cannot show commit even for an old writable batch',async()=>{
  const hooks=hooksHarness(React),calls=[];
  const workspace={canImport:true,canManageAccess:true,reminder:{dueOn:'2026-10-01',complete:false,mamComplete:false,equipsyComplete:false},recentBatches:[]};
  const batch={batchId,status:'staged',version:1,comparisonOnly:false,rows:[],files:[],comparisonRows:[]};
  const mod=loadModule('src/components/payroll-balance-importer.tsx',{
    react:{...hooks.react,startTransition:fn=>fn()},'@/components/ui/use-dialog-focus':{useDialogFocus(){}},
    '@/app/payroll-balances/actions':{
      getPayrollBalanceImportWorkspace:async id=>{calls.push(['read',id]);return {status:'ready',workspace};},
      stagePayrollBalanceFiles:async(form,id)=>{calls.push(['stage',id]);return {ok:true,batch};},
    },
  });
  const props={comparisonOnly:true,previewPersonId:targetId,hideManagementControls:true,onSaved:async()=>{}};
  const render=()=>{hooks.begin();const tree=mod.PayrollBalanceImporter(props);hooks.effects();return tree;};
  render();await flush();let tree=render();
  nodes(tree).find(n=>n.type==='input'&&n.props.type==='file').props.onChange({currentTarget:{files:[new File(['synthetic'],'payroll.csv')]}});
  await flush();tree=render();
  assert.deepEqual(calls.slice(0,2),[['read',targetId],['stage',targetId]]);
  assert.ok(!nodes(tree).some(n=>n.type==='button'&&text(n)==='Apply matched balances'));
  assert.ok(!text(tree).includes('Manage access'));
});
for (const operation of ['detail','commit']) test(`preview batch ${operation} denies batches omitted by the DB projection for a foreign uploader`,async()=>{
  const otherBatch = {...fullBatch(false),batchId:'12000000-0000-4000-8000-000000000003'};
  const f = payrollActionFixture({workspace:{data:previewWorkspace([otherBatch]),error:null}});
  if (operation==='detail') await assert.rejects(f.actions.getPayrollBalanceImportBatch(batchId,targetId),{message:loadError});
  else assert.deepEqual(await f.actions.commitPayrollBalanceImport(batchId,1,targetId),{ok:false,message:loadError});
  assert.ok(!f.calls.some(call=>['get_payroll_balance_import_batch','commit_payroll_balance_import'].includes(call.name)));
  assert.ok(!f.calls.some(call=>call.name==='get_payroll_balance_import_workspace'));
});
for (const operation of ['detail','commit']) test(`preview batch ${operation} rejects malformed and failed scoped DB projections before actor-wide RPCs`,async()=>{
  const valid = previewWorkspace([fullBatch(false)]);
  const failures = [
    {data:null,error:null}, {data:[],error:null}, {data:{},error:null},
    {data:{canImport:false,canManageAccess:false},error:null},
    {data:{...valid,canImport:'true'},error:null}, {data:{...valid,recentBatches:null},error:null},
    {data:{...valid,recentBatches:[{batchId}]},error:null},
    {data:{...valid,recentBatches:[...valid.recentBatches,{batchId:'malformed'}]},error:null},
    {data:{...valid,recentBatches:[{...valid.recentBatches[0],rowCount:-1}]},error:null},
    {data:{...valid,comparisonOnly:undefined},error:null}, {data:{...valid,comparisonOnly:'false'},error:null},
    {data:{...valid,canManageBalances:undefined},error:null}, {data:{...valid,canManageBalances:'true'},error:null},
    {data:{...valid,canManageAccess:null},error:null}, {data:{...valid,reminder:{}},error:null},
    {data:valid,error:{code:'42501',message:'Synthetic provider denial'}}, new Error('Synthetic connection reset'),
  ];
  for (const [index,workspace] of failures.entries()) {
    const f = payrollActionFixture({workspace});
    if (operation==='detail') await assert.rejects(f.actions.getPayrollBalanceImportBatch(batchId,targetId),{message:loadError},`projection case ${index}`);
    else assert.deepEqual(await f.actions.commitPayrollBalanceImport(batchId,1,targetId),{ok:false,message:loadError},`projection case ${index}`);
    assert.ok(!f.calls.some(call=>['get_payroll_balance_import_batch','commit_payroll_balance_import'].includes(call.name)),`projection case ${index}`);
  }
});
test('matching recent Admin preview batch detail uses scoped membership before authenticated payload loading',async()=>{
  const f = payrollActionFixture({workspace:{data:previewWorkspace([fullBatch(false)]),error:null}});
  const batch = await f.actions.getPayrollBalanceImportBatch(batchId,targetId);
  assert.equal(batch.batchId,batchId);
  assert.equal(batch.comparisonOnly,false);
  assert.deepEqual(f.calls.filter(call=>call.name.startsWith('get_payroll_balance_import_')),[
    {name:'get_payroll_balance_import_workspace_for_preview',args:{p_person_id:targetId}},
    {name:'get_payroll_balance_import_batch',args:{p_batch_id:batchId}},
  ]);
});
test('default Admin and P0 retain batch reads and commits without applying preview recent-window restrictions',async()=>{
  for (const role of ['admin','system_admin']) {
    const f = payrollActionFixture({actor:capabilities(role,role==='system_admin'?null:targetId)});
    assert.equal((await f.actions.getPayrollBalanceImportBatch(batchId)).batchId,batchId);
    assert.equal((await f.actions.commitPayrollBalanceImport(batchId,1)).ok,true);
    assert.ok(!f.calls.some(call=>call.name.includes('workspace')));
    assert.deepEqual(f.calls.filter(call=>call.name.includes('payroll_balance_import')),[
      {name:'get_payroll_balance_import_batch',args:{p_batch_id:batchId}},
      {name:'commit_payroll_balance_import',args:{p_batch_id:batchId,p_expected_version:1}},
    ]);
  }
});
test('Account batch comparisons remain readable in current and matching preview scope but never commit',async()=>{
  for (const previewPersonId of [undefined,targetId]) {
    const f = payrollActionFixture({
      ...(previewPersonId?{target:capabilities('account')}:{actor:capabilities('account')}),
      workspace:{data:{...previewWorkspace([fullBatch(true)]),comparisonOnly:true,canManageBalances:false},error:null},
      batch:{data:fullBatch(true),error:null},
    });
    assert.equal((await f.actions.getPayrollBalanceImportBatch(batchId,previewPersonId)).comparisonOnly,true);
    assert.deepEqual(await f.actions.commitPayrollBalanceImport(batchId,1,previewPersonId),{ok:false,message:'Comparison-only access cannot apply payroll balances.'});
    assert.ok(!f.calls.some(call=>call.name==='commit_payroll_balance_import'));
  }
});
test('Account preview never returns a writable or malformed comparison batch despite scoped membership',async()=>{
  for (const batch of [fullBatch(false),{...fullBatch(true),comparisonOnly:'true'},{},null]) {
    const f = payrollActionFixture({target:capabilities('account'),workspace:{data:{...previewWorkspace([fullBatch(true)]),comparisonOnly:true,canManageBalances:false},error:null},batch:{data:batch,error:null}});
    await assert.rejects(f.actions.getPayrollBalanceImportBatch(batchId,targetId),{message:loadError});
    assert.deepEqual(await f.actions.commitPayrollBalanceImport(batchId,1,targetId),{ok:false,message:'Comparison-only access cannot apply payroll balances.'});
    assert.ok(!f.calls.some(call=>call.name==='commit_payroll_balance_import'));
  }
});
