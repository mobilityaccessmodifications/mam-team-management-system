import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {loadModule} from './helpers/contact-lifetime-harness.mjs';
test('subscription notification contract is metadata-only and has no added audience',()=>{
  assert.ok(existsSync('src/lib/subscription-request-notifications.ts'),'Request notification envelope is not implemented');
  const {requestNotification}=loadModule('src/lib/subscription-request-notifications.ts');
  const input={request_id:'b1000000-0000-4000-8000-000000000001',version:2,event:'submit',to_user_id:'a1000000-0000-4000-8000-000000000004',cc_user_ids:[]};
  const result=requestNotification(input);
  assert.deepEqual(result.ccUserIds,[]);assert.equal(result.toUserId,input.to_user_id);
  assert.equal(result.eventKey,'subscription-request:'+input.request_id+':2');
  assert.match(result.link,/^https:\/\/mam-team-management-system-ten\.vercel\.app\/subscription-requests\?request=/);
  assert.throws(()=>requestNotification({...input,cc_user_ids:[input.to_user_id]}));
  assert.throws(()=>requestNotification({...input,payload:{password:'DO NOT COPY'}}));
  assert.throws(()=>requestNotification({...input,event:'activate'}));
});
