import assert from 'node:assert/strict';
import * as React from 'react';
import test from 'node:test';
import { actionFixture, capabilities, hooksHarness, loadModule, nodes, requireAction, targetId, text, flush } from './helpers/unified-role-harness.mjs';
async function delegationDialogFixture({registerResult = {ok:true}, vaultResult = {ok:true}, callbackThrows = false} = {}) {
  const hooks = hooksHarness(React), calls = [], loads = [], snapshots = {management:[],vault:[]};
  const mod = loadModule('src/components/subscription-delegation-dialog.tsx',{
    react:hooks.react,'@/components/ui/use-dialog-focus':{useDialogFocus(){}},
    '@/app/subscriptions/delegation-actions':{
      listSubscriptionManagementDelegates:async()=>{loads.push('management');return {ok:true,delegates:snapshots.management};},
      replaceSubscriptionManagementDelegates:async ids=>{calls.push(['management',ids]);if (registerResult instanceof Error) throw registerResult;return registerResult;},
    },
    '@/app/subscription-credentials/actions':{
      listSubscriptionCredentialGrantCandidates:async()=>{loads.push('candidates');return [{personId:targetId,fullName:'Synthetic Manager',positionTitle:'Tester'}];},
      listSubscriptionCredentialAccessGrants:async()=>{loads.push('vault');return snapshots.vault;},
      replaceSubscriptionCredentialAccessGrants:async ids=>{calls.push(['vault',ids]);if (vaultResult instanceof Error) throw vaultResult;return vaultResult;},
    },
  });
  const props = {onClose:()=>calls.push(['close']),onSaved:()=>{calls.push(['invalidate']);if (callbackThrows) throw new Error('Synthetic callback failure');}};
  const render = () => {hooks.begin();const tree=mod.SubscriptionDelegationDialog(props);hooks.effects();return tree;};
  render();await flush();
  for (const label of ['Register management','Credential vault']) {
    nodes(render()).find(node=>node.type==='input' && node.props['aria-label'].startsWith(label)).props.onChange();
  }
  const save = async () => {nodes(render()).find(node=>node.type==='button' && text(node)==='Save delegation').props.onClick();await flush();return render();};
  return {calls,loads,snapshots,render,save};
}
test('successful management save invalidates once when the independent vault save throws',async()=>{
  const f = await delegationDialogFixture({vaultResult:new Error('Synthetic transport failure')});
  let tree = await f.save();
  assert.deepEqual(f.calls,[['management',[targetId]],['vault',[targetId]],['invalidate']]);
  assert.ok(nodes(tree).some(node=>node.props?.role==='dialog'));
  assert.match(text(tree),/could not be confirmed|not confirmed/);
  assert.doesNotMatch(text(tree),/Credential access was saved/);
  assert.equal(nodes(tree).find(node=>node.type==='button' && text(node)==='Save delegation').props.disabled,true);
  assert.ok(nodes(tree).some(node=>node.type==='button' && text(node)==='Reload delegation'));
  const switches=nodes(tree).filter(node=>node.type==='input' && node.props.role==='switch');
  assert.ok(switches.every(node=>node.props.checked && node.props.disabled));
  tree = await f.save();
  assert.equal(f.calls.length,3);
  assert.equal(f.loads.length,3);
  assert.ok(nodes(tree).some(node=>node.props?.role==='alert'));
});
test('subscription management delegates require actual P0 and use the exact independent audited RPCs', async () => {
  const f = actionFixture();
  f.client.rpc = async (name,args) => {
    f.calls.push({name,args});
    if (name==='get_portal_role_capabilities') return {data:[capabilities('system_admin',null)],error:null};
    if (name==='list_subscription_management_delegates') return {data:[{person_id:targetId,full_name:'Synthetic Manager',position_title:'Tester'}],error:null};
    if (name==='replace_subscription_management_delegates') return {data:null,error:null};
    assert.fail('unexpected RPC '+name);
  };
  const mod = f.load('src/app/subscriptions/delegation-actions.ts');
  assert.deepEqual(await requireAction(mod,'listSubscriptionManagementDelegates')(),{ok:true,delegates:[{personId:targetId,fullName:'Synthetic Manager',positionTitle:'Tester'}]});
  assert.deepEqual(await requireAction(mod,'replaceSubscriptionManagementDelegates')([targetId]),{ok:true});
  assert.ok(f.calls.some(call=>call.name==='replace_subscription_management_delegates' && call.args.p_person_ids[0]===targetId));
  assert.ok(!f.calls.some(call=>call.name.includes('credential_access')));
  const denied = actionFixture({actor:capabilities('admin')});
  assert.equal((await requireAction(denied.load('src/app/subscriptions/delegation-actions.ts'),'replaceSubscriptionManagementDelegates')([targetId])).ok,false);
  assert.ok(!denied.calls.some(call=>call.name==='replace_subscription_management_delegates'));
});
test('a known committed management grant change invalidates parent state without blindly saving vault grants',async()=>{
  const hooks=hooksHarness(React),calls=[];
  const mod=loadModule('src/components/subscription-delegation-dialog.tsx',{
    react:hooks.react,'@/components/ui/use-dialog-focus':{useDialogFocus(){}},
    '@/app/subscriptions/delegation-actions':{
      listSubscriptionManagementDelegates:async()=>({ok:true,delegates:[]}),
      replaceSubscriptionManagementDelegates:async ids=>{calls.push(['management',ids]);return {ok:false,committed:true,message:'Subscription management access was saved, but could not be refreshed.'};},
    },
    '@/app/subscription-credentials/actions':{
      listSubscriptionCredentialGrantCandidates:async()=>[{personId:targetId,fullName:'Synthetic Manager',positionTitle:'Tester'}],listSubscriptionCredentialAccessGrants:async()=>[],
      replaceSubscriptionCredentialAccessGrants:async ids=>{calls.push(['vault',ids]);return {ok:true};},
    },
  });
  const props={onClose:()=>calls.push(['close']),onSaved:()=>calls.push(['invalidate'])};
  const render=()=>{hooks.begin();const tree=mod.SubscriptionDelegationDialog(props);hooks.effects();return tree;};
  render();await flush();let tree=render();
  nodes(tree).find(n=>n.type==='input' && /Register management/.test(n.props['aria-label'])).props.onChange();tree=render();
  nodes(tree).find(n=>n.type==='button' && text(n)==='Save delegation').props.onClick();await flush();tree=render();
  assert.deepEqual(calls,[['management',[targetId]],['invalidate']]);
  assert.equal(nodes(tree).find(n=>n.type==='button' && text(n)==='Save delegation').props.disabled,true);
});
test('subscription page exposes separate management/vault switches, controlled only by P0', async () => {
  const hooks = hooksHarness(React);
  const mod = loadModule('src/components/subscription-delegation-dialog.tsx',{
    react:hooks.react, '@/components/ui/use-dialog-focus':{useDialogFocus(){}},
    '@/app/subscriptions/delegation-actions':{listSubscriptionManagementDelegates:async()=>({ok:true,delegates:[]})},
    '@/app/subscription-credentials/actions':{listSubscriptionCredentialGrantCandidates:async()=>[{personId:targetId,fullName:'Synthetic Manager',positionTitle:'Tester'}],listSubscriptionCredentialAccessGrants:async()=>[]},
  });
  const Dialog = requireAction(mod,'SubscriptionDelegationDialog');
  const render = () => {hooks.begin(); const tree=Dialog({onClose(){}}); hooks.effects();return tree;};
  render();await flush();const tree=render();
  const switches=nodes(tree).filter(n=>n.type==='input' && n.props.role==='switch');
  assert.equal(switches.length,2);
  assert.ok(switches.some(n=>/Register management/.test(n.props['aria-label'])));
  assert.ok(switches.some(n=>/Credential vault/.test(n.props['aria-label'])));
  assert.match(text(tree),/Admin.*role|role.*Admin/);
  assert.match(text(tree),/Active Managers and Employees/);
});
test('acknowledged vault failure invalidates committed management once and retains a blocked draft',async()=>{
  const f = await delegationDialogFixture({vaultResult:{ok:false,message:'Synthetic acknowledged failure'}});
  let tree = await f.save();
  assert.deepEqual(f.calls,[['management',[targetId]],['vault',[targetId]],['invalidate']]);
  assert.match(text(tree),/Register management was saved\. Credential access was not confirmed/);
  assert.ok(nodes(tree).filter(node=>node.type==='input').every(node=>node.props.checked && node.props.disabled));
  assert.equal(nodes(tree).find(node=>node.type==='button' && text(node)==='Save delegation').props.disabled,true);
  assert.ok(nodes(tree).some(node=>node.type==='button' && text(node)==='Reload delegation'));
  tree = await f.save();
  assert.equal(f.calls.length,3);
  assert.equal(f.loads.length,3);
  assert.ok(nodes(tree).some(node=>node.props?.role==='dialog'));
});
test('successful independent management and vault saves invalidate once before closing',async()=>{
  const f = await delegationDialogFixture();
  const tree = await f.save();
  assert.deepEqual(f.calls,[['management',[targetId]],['vault',[targetId]],['invalidate'],['close']]);
  assert.ok(!nodes(tree).some(node=>node.props?.role==='alert'));
});
test('uncommitted management rejection leaves an editable draft without vault writes or parent invalidation',async()=>{
  const f = await delegationDialogFixture({registerResult:{ok:false,message:'Synthetic rejected management save'}});
  let tree = await f.save();
  assert.deepEqual(f.calls,[['management',[targetId]]]);
  assert.match(text(tree),/Synthetic rejected management save/);
  assert.ok(nodes(tree).filter(node=>node.type==='input').every(node=>node.props.checked && !node.props.disabled));
  assert.equal(nodes(tree).find(node=>node.type==='button' && text(node)==='Save delegation').props.disabled,false);
  assert.ok(!nodes(tree).some(node=>node.type==='button' && text(node)==='Reload delegation'));
  tree = await f.save();
  assert.deepEqual(f.calls,[['management',[targetId]],['management',[targetId]]]);
  assert.ok(nodes(tree).some(node=>node.props?.role==='dialog'));
});
test('unknown management transport outcome blocks retries without falsely invalidating a known commit',async()=>{
  const f = await delegationDialogFixture({registerResult:new Error('Synthetic management transport failure')});
  const tree = await f.save();
  assert.deepEqual(f.calls,[['management',[targetId]]]);
  assert.equal(nodes(tree).find(node=>node.type==='button' && text(node)==='Save delegation').props.disabled,true);
  assert.match(text(tree),/could not be confirmed/);
  await f.save();
  assert.equal(f.calls.length,1);
});
test('parent callback exceptions cannot repeat invalidation or mutations and never close a refresh-required dialog',async()=>{
  for (const options of [
    {}, {vaultResult:new Error('Synthetic vault transport failure')},
    {registerResult:{ok:false,committed:true,message:'Synthetic committed warning'}},
  ]) {
    const f = await delegationDialogFixture({...options,callbackThrows:true});
    const tree = await f.save();
    assert.equal(f.calls.filter(([name])=>name==='invalidate').length,1);
    assert.ok(!f.calls.some(([name])=>name==='close'));
    assert.equal(nodes(tree).find(node=>node.type==='button' && text(node)==='Save delegation').props.disabled,true);
    assert.match(text(tree),/could not be confirmed/);
    const before = f.calls.length;
    await f.save();
    assert.equal(f.calls.length,before);
  }
});
test('partial grant saves stay blocked until an explicit authoritative delegation reload without automatic mutations',async()=>{
  const f = await delegationDialogFixture({vaultResult:new Error('Synthetic vault transport failure')});
  let tree = await f.save();
  assert.equal(f.loads.length,3);
  f.snapshots.management = [{personId:targetId,fullName:'Synthetic Manager',positionTitle:'Tester'}];
  nodes(tree).find(node=>node.type==='button' && text(node)==='Reload delegation').props.onClick();
  tree = f.render();
  assert.match(text(tree),/Loading delegates/);
  await flush();tree = f.render();
  assert.equal(f.loads.length,6);
  assert.deepEqual(f.calls,[['management',[targetId]],['vault',[targetId]],['invalidate']]);
  const switches = nodes(tree).filter(node=>node.type==='input');
  assert.equal(switches.find(node=>node.props['aria-label'].startsWith('Register management')).props.checked,true);
  assert.equal(switches.find(node=>node.props['aria-label'].startsWith('Credential vault')).props.checked,false);
  assert.ok(switches.every(node=>!node.props.disabled));
  assert.equal(nodes(tree).find(node=>node.type==='button' && text(node)==='Save delegation').props.disabled,false);
  assert.ok(!nodes(tree).some(node=>node.props?.role==='alert'));
});
