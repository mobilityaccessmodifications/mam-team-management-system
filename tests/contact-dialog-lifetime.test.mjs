import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import { hooksHarness, loadModule, nodes, text, deferred, flush } from './helpers/contact-lifetime-harness.mjs';
for (const outcome of ['success', 'failure']) for (const identical of [false, true]) for (const returnToA of [false, true]) test(`contact continuation preserves new draft and busy outcome=${outcome} identical=${identical} returnToA=${returnToA}`, async () => {
  const hooks = hooksHarness(React), first = deferred(), second = deferred();
  globalThis.requestAnimationFrame = fn => fn();
  globalThis.window = { addEventListener() {}, removeEventListener() {}, innerWidth: 1440 };
  const menu = loadModule('src/components/self-profile-menu.tsx', { react: hooks.react, '@/components/ui/use-dialog-focus': { useDialogFocus() {} }, '@/components/ui/modal-backdrop': { ModalBackdrop: 'backdrop' } });
  const a = { name: 'Synthetic A', title: 'Tester', company: 'mam', phone: '111' }, b = identical ? {...a} : {...a, name:'Synthetic B',phone:'222'};
  let profile=a, scopeKey='A:0', calls=0;
  const render=()=>{hooks.begin();const tree=menu.SelfProfileMenu({profile,scopeKey,mode:'hr-preview',onSave:()=>++calls===1?first.promise:second.promise});hooks.effects();return tree;};
  const phone=tree=>nodes(tree).find(n=>n.type==='input'&&n.props.type==='tel');
  const open=()=>{let tree=render();nodes(tree).find(n=>n.type==='button'&&n.props['aria-haspopup']==='dialog').props.onClick();return render();};
  const submit=tree=>nodes(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){},currentTarget:{checkValidity:()=>true}});
  let tree=open();phone(tree).props.onChange({target:{value:'A pending'}});const saving=submit(render());
  tree=render();nodes(tree).find(n=>n.type==='button'&&n.props['aria-label']==='Close profile').props.onClick();
  profile=b;scopeKey='B:1';render();
  if(returnToA){profile=a;scopeKey='A:2';render();}
  tree=open();phone(tree).props.onChange({target:{value:'new draft'}});tree=render();
  assert.doesNotMatch(text(tree),/Saving/);
  const newer=submit(tree);tree=render();assert.match(text(tree),/Saving/);
  first.resolve(outcome==='success'?{message:'Old saved'}:Promise.reject(new Error('synthetic rejected save')));await saving;await flush();tree=render();
  assert.equal(phone(tree).props.value,'new draft');assert.match(text(tree),/Saving/);assert.equal(nodes(tree).filter(n=>n.props?.['data-tone']).length,0);
  second.resolve({message:'New saved'});await newer;tree=render();assert.equal(phone(tree).props.value,'new draft');assert.match(text(tree),/New saved/);assert.doesNotMatch(text(tree),/Saving/);
});

test('self save retains confirmation and saved contacts after the parent replaces the DTO',async()=>{
  const hooks=hooksHarness(React);
  globalThis.window={addEventListener(){},removeEventListener(){},innerWidth:1440};
  const menu=loadModule('src/components/self-profile-menu.tsx',{react:hooks.react,'@/components/ui/use-dialog-focus':{useDialogFocus(){}},'@/components/ui/modal-backdrop':{ModalBackdrop:'backdrop'}});
  let profile={name:'Synthetic Self',title:'Tester',company:'mam',phone:'111'};
  const render=()=>{hooks.begin();const tree=menu.SelfProfileMenu({profile,scopeKey:'self:0',onSave:async changes=>{profile={...profile,...changes};return {message:'Self saved'};}});hooks.effects();return tree;};
  let tree=render();nodes(tree).find(n=>n.type==='button'&&n.props['aria-haspopup']==='dialog').props.onClick();tree=render();
  nodes(tree).find(n=>n.type==='input'&&n.props.type==='tel').props.onChange({target:{value:'saved self phone'}});tree=render();
  await nodes(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){},currentTarget:{checkValidity:()=>true}});
  tree=render();tree=render();assert.match(text(tree),/Self saved/);assert.doesNotMatch(text(tree),/Saving/);
  assert.equal(nodes(tree).find(n=>n.type==='input'&&n.props.type==='tel').props.value,'saved self phone');
});

test('late contact completion preserves the new selection validation feedback',async()=>{
  const hooks=hooksHarness(React),pending=deferred();globalThis.requestAnimationFrame=fn=>fn();
  globalThis.window={addEventListener(){},removeEventListener(){},innerWidth:1440};
  const menu=loadModule('src/components/self-profile-menu.tsx',{react:hooks.react,'@/components/ui/use-dialog-focus':{useDialogFocus(){}},'@/components/ui/modal-backdrop':{ModalBackdrop:'backdrop'}});
  const profile={name:'Synthetic Same',title:'Tester',company:'mam',phone:'111'};let scopeKey='A:0';
  const render=()=>{hooks.begin();const tree=menu.SelfProfileMenu({profile,scopeKey,mode:'hr-preview',onSave:()=>pending.promise});hooks.effects();return tree;};
  const open=()=>{let tree=render();nodes(tree).find(n=>n.type==='button'&&n.props['aria-haspopup']==='dialog').props.onClick();return render();};
  const submit=tree=>nodes(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){},currentTarget:{checkValidity:()=>true}});
  let tree=open();nodes(tree).find(n=>n.type==='input'&&n.props.type==='tel').props.onChange({target:{value:'pending A'}});const saving=submit(render());
  nodes(render()).find(n=>n.type==='button'&&n.props['aria-label']==='Close profile').props.onClick();scopeKey='B:1';render();tree=open();
  nodes(tree).find(n=>n.type==='input'&&n.props.type==='date').props.onChange({target:{value:'9999-01-01'}});await submit(render());tree=render();
  const before=nodes(tree).filter(n=>n.props?.['data-tone']).map(n=>[n.props['data-tone'],text(n)]);assert.equal(before[0][0],'error');
  pending.resolve({message:'Old saved'});await saving;tree=render();
  assert.deepEqual(nodes(tree).filter(n=>n.props?.['data-tone']).map(n=>[n.props['data-tone'],text(n)]),before);assert.doesNotMatch(text(tree),/Saving/);
});

for (const outcome of ['success', 'failure']) for (const close of ['button', 'backdrop']) test(`same selection ${close} close retires feedback but not mutation outcome=${outcome}`,async()=>{
  const hooks=hooksHarness(React),pending=deferred();let calls=0,reloads=0,liveAtCommit;
  globalThis.requestAnimationFrame=fn=>fn();
  globalThis.window={addEventListener(){},removeEventListener(){},innerWidth:1440,location:{reload(){reloads++;}}};
  const menu=loadModule('src/components/self-profile-menu.tsx',{react:hooks.react,'@/components/ui/use-dialog-focus':{useDialogFocus(){}},'@/components/ui/modal-backdrop':{ModalBackdrop:'backdrop'}});
  let profile={name:'Synthetic A',title:'Tester',company:'mam',phone:'111'};
  const render=()=>{hooks.begin();const tree=menu.SelfProfileMenu({profile,scopeKey:'A:0',onSave:async(changes,isCurrent)=>{calls++;await pending.promise;liveAtCommit=isCurrent?.();if(liveAtCommit!==false)profile={...profile,...changes};return {message:'Old saved'};}});hooks.effects();return tree;};
  const phone=tree=>nodes(tree).find(n=>n.type==='input'&&n.props.type==='tel');
  const open=()=>{nodes(render()).find(n=>n.type==='button'&&n.props['aria-haspopup']==='dialog').props.onClick();return render();};
  const submit=tree=>nodes(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){},currentTarget:{checkValidity:()=>true}});
  let tree=open();phone(tree).props.onChange({target:{value:'old pending'}});const saving=submit(render());tree=render();
  if(close==='button')nodes(tree).find(n=>n.props['aria-label']==='Close profile').props.onClick();
  else {const overlay=nodes(tree).find(n=>n.type==='backdrop');const target={};overlay.props.onPointerDown({target,currentTarget:target});}
  tree=open();phone(tree).props.onChange({target:{value:'new draft'}});tree=render();await submit(tree);assert.equal(calls,1);
  assert.doesNotMatch(text(tree),/Saving/);assert.equal(nodes(tree).find(n=>n.type==='button'&&n.props.type==='submit').props.disabled,true);
  profile={...profile,phone:'late DTO'};tree=render();assert.equal(phone(tree).props.value,'new draft');
  pending.resolve(outcome==='success'?undefined:Promise.reject(new Error('uncertain transport')));await saving;tree=render();
  assert.equal(phone(tree).props.value,'new draft');assert.equal(nodes(tree).filter(n=>n.props?.['data-tone']).length,0);assert.match(text(tree),/Refresh profile/);
  if(outcome==='success')assert.equal(liveAtCommit,false);
  await submit(tree);assert.equal(calls,1);assert.equal(reloads,0);
  nodes(tree).find(n=>n.type==='button'&&text(n)==='Refresh profile').props.onClick();assert.equal(reloads,1);
});
