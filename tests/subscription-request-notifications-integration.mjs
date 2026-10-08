import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sql,target} from '../scripts/local-test-postgres.mjs';
import {loadModule} from './helpers/contact-lifetime-harness.mjs';

const [socket,database]=process.argv.slice(2);
assert.equal(process.argv.length,4,'An owned socket and synthetic database are required');
target(socket,database);
const applicant='a1000000-0000-4000-8000-000000000013';
const approver='a1000000-0000-4000-8000-000000000004';
const first='b1000000-0000-4000-8000-000000000071';
const second='b1000000-0000-4000-8000-000000000072';
const draft='b1000000-0000-4000-8000-000000000073';
const payload={kind:'new_purchase',service:'Synthetic recipient routing',purpose:'Work',company:'mam',payer:'MAM',duration:'Year',billing:'annual',currency:'AUD',tax:'Inclusive',quoteCents:100,audEstimateCents:100,payment:'non_card',intendedUsers:'Synthetic team'};
const literal=value=>"'"+String(value).replaceAll("'","''")+"'";
const fixture=readFileSync('tests/unified-role-fixture.sql','utf8').replace('\\ir sql-test-auth.sql',()=>readFileSync('tests/sql-test-auth.sql','utf8'));
const mutate=(actor,id,version,event)=>`select pg_temp.set_test_actor(${literal(actor)});set local role authenticated;select public.sr_mutate(${literal(id)},${version},${literal(event)},${literal(JSON.stringify(payload))}::jsonb,'Synthetic decision');reset role;`;
const statements=[
  mutate(applicant,first,0,'save'),mutate(applicant,first,1,'submit'),mutate(approver,first,2,'return'),
  mutate(applicant,first,3,'save'),mutate(applicant,first,4,'submit'),mutate(approver,first,5,'approve'),mutate(applicant,first,6,'withdraw'),
  mutate(applicant,second,0,'submit'),mutate(approver,second,1,'reject'),mutate(applicant,draft,0,'save'),mutate(applicant,draft,1,'withdraw'),
];
const before=sql(socket,database,'select private.confirmed_test_purge_schema_hash();').trim();
const output=sql(socket,database,`begin;${fixture}\nupdate private.subscription_request_config set enabled=true,approver_user_id=${literal(approver)},approver_person_id=${literal(approver)};\n${statements.join('\n')}\nselect jsonb_agg(jsonb_build_object('request_id',n.request_id,'version',n.version,'event',n.event,'to_user_id',n.to_user_id,'cc_user_ids',n.cc_user_ids) order by n.request_id,n.version) from private.subscription_request_notifications n;rollback;`);
const rows=JSON.parse(output.trim().split('\n').at(-1));
const expected=[
  [first,2,'submit',approver],[first,3,'return',applicant],[first,5,'submit',approver],[first,6,'approve',applicant],[first,7,'withdraw',approver],
  [second,1,'submit',approver],[second,2,'reject',applicant],[draft,2,'withdraw',approver],
].map(([request_id,version,event,to_user_id])=>({request_id,version,event,to_user_id,cc_user_ids:[]}));
assert.deepEqual(rows,expected,'Every persisted event must target the correct distinct applicant/approver; saves must not notify');
const {requestNotification}=loadModule('src/lib/subscription-request-notifications.ts');
const subjects={submit:'Subscription request submitted',approve:'Subscription request approved',return:'Subscription request returned',reject:'Subscription request rejected',withdraw:'Subscription request withdrawn'};
for (const row of rows) {
  assert.deepEqual(requestNotification(row),{eventKey:`subscription-request:${row.request_id}:${row.version}`,toUserId:row.to_user_id,ccUserIds:[],subject:subjects[row.event],link:`https://mam-team-management-system-ten.vercel.app/subscription-requests?request=${row.request_id}`});
}
assert.equal(sql(socket,database,'select private.confirmed_test_purge_schema_hash();').trim(),before,'Notification fixture must fully roll back');
assert.equal(sql(socket,database,'select private.confirmed_test_purge_schema_hash()=(select schema_hash from private.confirmed_test_purge_schema where singleton);').trim(),'t');
console.log(`PASS: ${rows.length} persisted notification intents project into exact sender-free envelopes with distinct applicant/approver, empty CC and immutable event keys`);
