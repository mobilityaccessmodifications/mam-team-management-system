// Explicit synthetic socket/database only; no production URL or credentials.
import {readFileSync} from 'node:fs';
import {spawnSync,spawn} from 'node:child_process';
const [socket,database='openclaw_leave_test']=process.argv.slice(2);
if(!/^\/private\/tmp\/mam-openclaw-pg\.[A-Za-z0-9]+$/.test(socket??'')||!/^openclaw_leave_test(_[0-9]+)?$/.test(database))throw new Error('Synthetic local target required');
const env={PATH:process.env.PATH};
const base=spawnSync(process.execPath,['tests/run-openclaw-leave-sql.mjs',socket,database],{env,stdio:'inherit'});
if(base.status!==0)process.exit(base.status??1);
const args=['-h',socket,'-p','55439','-d',database,'-v','ON_ERROR_STOP=1'];
function sql(text){const r=spawnSync('psql',args,{input:text,encoding:'utf8',env});process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');if(r.status!==0)throw new Error('Synthetic SQL failed');}
sql(readFileSync('supabase/migrations/20260921150000_openclaw_confirm_only.sql','utf8')+'\n'+readFileSync('tests/openclaw-confirm-only.sql','utf8'));
const confirm=key=>new Promise((resolve,reject)=>{
 const q=`set role service_role; select public.openclaw_leave_v3_submit(repeat('${key}3',32),repeat('f',64),snapshot->>'fingerprint',packet,person,draft,token_hash) from public.fixture_openclaw_v3_plan;`;
 const p=spawn('psql',[...args,'-Atq','-c',q],{env});let out='',err='';p.stdout.on('data',v=>out+=v);p.stderr.on('data',v=>err+=v);
 p.on('error',reject);p.on('close',code=>code===0?resolve(JSON.parse(out.trim())):reject(new Error(err)));
});
const results=await Promise.all([confirm('b'),confirm('c'),confirm('b')]);
if(results.some(r=>r.code!=='submitted'||JSON.stringify(r)!==JSON.stringify(results[0])))throw new Error('Exactly-once v3 race failed');
sql(`do $$declare x public.fixture_openclaw_v3_plan%rowtype; snap jsonb; result jsonb;begin
 select * into x from public.fixture_openclaw_v3_plan;
 assert (select count(*)=5 from public.leave_requests);
 assert (select count(*)=5 from private.leave_notification_outbox);
 assert (select count(*)=5 from private.leave_request_reviewer_assignments);
 assert (select count(*)=10 from public.leave_request_events);
 assert not exists(select 1 from private.openclaw_leave_drafts where id=(x.draft->>'id')::uuid and (body ? 'fields' or body ? 'summary'));
 begin
  perform public.openclaw_leave_v3_submit(repeat('e3',32),repeat('f',64),x.snapshot->>'fingerprint',x.packet,x.person,
   jsonb_set(x.draft,'{id}',to_jsonb(gen_random_uuid())),x.token_hash);
  raise exception 'Overlap accepted';
 exception when exclusion_violation then null;end;
 assert not exists(select 1 from private.openclaw_leave_receipts where key=repeat('e3',32));
 update public.internal_org_people set full_name='Renamed after success' where id=x.person;
 snap:=public.openclaw_leave_v3_snapshot(repeat('b3',32),(x.draft->>'id')::uuid);
 result:=public.openclaw_leave_v3_submit(repeat('b3',32),repeat('f',64),snap->>'fingerprint',x.packet,x.person,x.draft,x.token_hash);
 assert result->>'status'='Pending';
 -- Confirmed nonce can retrieve original after TTL without a second HR write.
 result:=public.openclaw_leave_v3_submit(repeat('d3',32),repeat('f',64),snap->>'fingerprint',x.packet,x.person,jsonb_set(x.draft,'{expiresAt}','1'),x.token_hash);
 assert result->>'status'='Pending';
 begin
  perform public.openclaw_leave_v3_submit(repeat('b3',32),repeat('e',64),snap->>'fingerprint',x.packet,x.person,x.draft,x.token_hash);
  raise exception 'Event reassignment accepted';
 exception when serialization_failure then null;end;
 update public.profiles set account_status='disabled' where id=(x.draft->>'userId')::uuid;
 snap:=public.openclaw_leave_v3_snapshot(repeat('b3',32),(x.draft->>'id')::uuid);
 begin
  perform public.openclaw_leave_v3_submit(repeat('b3',32),repeat('f',64),snap->>'fingerprint',x.packet,x.person,x.draft,x.token_hash);
  raise exception 'Disabled actor replay accepted';
 exception when insufficient_privilege then null;end;
 assert (select count(*)=5 from public.leave_requests);
end$$;`);
console.log('PASS v3: read-only preparation, rollback, ACL, source CAS, concurrent same-token/event, expiry and identity replay');
