// Local synthetic cluster only. Never accepts a production URL or password.
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
const socket=process.argv[2];
const database=process.argv[3]??'openclaw_leave_test';
if(!/^openclaw_leave_test(_[0-9]+)?$/.test(database))throw new Error('Synthetic database required');
if(!socket?.startsWith('/private/tmp/mam-openclaw-pg.'))throw new Error('Task-owned local socket required');
const extract=(path,start,end)=>{const source=fs.readFileSync(path,'utf8');const a=source.indexOf(start),b=source.indexOf(end,a);if(a<0||b<0)throw new Error('Fixture extraction failed');return source.slice(a,b);};
const sql=fs.readFileSync('tests/openclaw-leave-bootstrap.sql','utf8')+'\n'+
extract('supabase/migrations/20260818130000_configurable_leave_approval_grants.sql','create function public.submit_my_leave_request(', 'comment on function public.submit_my_leave_request')+'\n'+
extract('supabase/migrations/20260904140000_historical_leave_import_support.sql','create or replace function private.enforce_leave_request_employment_policy()', 'drop function public.list_leave_workspace_requests')+'\n'+
'create trigger employment before insert on public.leave_requests for each row execute function private.enforce_leave_request_employment_policy();\n'+
fs.readFileSync('supabase/migrations/20260917223558_openclaw_leave_bridge.sql','utf8')+'\n'+
fs.readFileSync('supabase/migrations/20260918120000_openclaw_self_profile.sql','utf8')+'\n'+
fs.readFileSync('tests/openclaw-leave.sql','utf8');
const result=spawnSync('psql',['-h',socket,'-p','55439','-d',database,'-v','ON_ERROR_STOP=1'],{input:sql,encoding:'utf8',env:{PATH:process.env.PATH}});
process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
if(result.status!==0)process.exit(result.status??1);
const args=['-h',socket,'-p','55439','-d',database,'-v','ON_ERROR_STOP=1'];
const setup=spawnSync('psql',args,{input:fs.readFileSync('tests/openclaw-leave-concurrency.sql','utf8'),encoding:'utf8',env:{PATH:process.env.PATH}});
if(setup.status!==0){process.stderr.write(setup.stderr??'');process.exit(setup.status??1);}
// Prepare a v1 draft BEFORE upgrading. A later v1 confirmation obtains a fresh
// source snapshot (fingerprints belong to request plans, not stored drafts).
const upgrade=spawnSync('psql',args,{input:fs.readFileSync('supabase/migrations/20260920120000_openclaw_quoted_confirm.sql','utf8')+`
do $$declare before_upgrade text; after_upgrade jsonb;begin
 select snapshot->>'fingerprint' into before_upgrade from public.fixture_openclaw_plan;
 select public.openclaw_leave_snapshot(repeat('7',64),(draft->>'id')::uuid) into after_upgrade from public.fixture_openclaw_plan;
 assert before_upgrade<>after_upgrade->>'fingerprint','Name must join current source fingerprint';
 assert after_upgrade->'draft'=(select draft from public.fixture_openclaw_plan),'Upgrade changed an in-flight legacy draft';
 assert not has_function_privilege('service_role','private.openclaw_leave_people()','execute');
 assert not has_function_privilege('authenticated','public.openclaw_leave_commit(text,text,text,text,jsonb,uuid,jsonb,jsonb,boolean)','execute');
 update public.fixture_openclaw_plan set snapshot=after_upgrade;
end$$;`,encoding:'utf8',env:{PATH:process.env.PATH}});
process.stdout.write(upgrade.stdout??'');process.stderr.write(upgrade.stderr??'');
if(upgrade.status!==0)process.exit(upgrade.status??1);
// Both connections use the frozen PRE-submit snapshot, not a sequential mock.
const confirm=(key,table='fixture_openclaw_plan')=>new Promise((resolve,reject)=>{
 const sql=`set role service_role; select public.openclaw_leave_commit(repeat('${key}',64),repeat('f',64),snapshot->>'fingerprint',snapshot->>'draftFingerprint',packet,person,draft,'{}',true) from public.${table};`;
 const child=spawn('psql',[...args,'-Atq','-c',sql],{env:{PATH:process.env.PATH}});
 let stdout='',stderr='';child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);
 child.on('error',reject);child.on('close',code=>code===0?resolve(JSON.parse(stdout.trim())):reject(new Error(stderr)));
});
const [first,second]=await Promise.all([confirm('7'),confirm('8')]);
if(first.code!=='submitted'||JSON.stringify(first)!==JSON.stringify(second))throw new Error('Concurrent retry mismatch');
process.stdout.write('Concurrent PostgreSQL confirmations: same Pending result\n');
const retention=spawnSync('psql',args,{input:fs.readFileSync('tests/openclaw-leave-retention.sql','utf8'),encoding:'utf8',env:{PATH:process.env.PATH}});
process.stdout.write(retention.stdout??'');process.stderr.write(retention.stderr??'');
if(retention.status!==0)process.exit(retention.status??1);
const quoted=spawnSync('psql',args,{input:fs.readFileSync('tests/openclaw-quoted-confirm.sql','utf8'),encoding:'utf8',env:{PATH:process.env.PATH}});
process.stdout.write(quoted.stdout??'');process.stderr.write(quoted.stderr??'');
if(quoted.status!==0)process.exit(quoted.status??1);
const [quotedFirst,quotedSecond]=await Promise.all([confirm('9','fixture_openclaw_v2_plan'),confirm('a','fixture_openclaw_v2_plan')]);
if(quotedFirst.code!=='submitted'||JSON.stringify(quotedFirst)!==JSON.stringify(quotedSecond))throw new Error('Concurrent quoted-Confirm retry mismatch');
const final=spawnSync('psql',args,{input:`do $$begin
 assert (select count(*)=4 from public.leave_requests),'v2 duplicate submission';
 assert (select count(*)=4 from private.leave_notification_outbox),'v2 duplicate notification';
 assert (select count(*)=4 from private.leave_request_reviewer_assignments);
 assert (select count(*)=8 from public.leave_request_events);
end$$;
-- Source fingerprints are fresh per-operation plans, never stored draft
-- requirements. A directory change between operations permits receipt replay;
-- one between snapshot and commit must still fail closed before returning it.
begin;
update public.internal_org_people set full_name='Synthetic Renamed After Submit'
 where id='10000000-0000-4000-8000-000000000001';
set role service_role;
do $$declare plan public.fixture_openclaw_v2_plan%rowtype; snap jsonb; replay jsonb;begin
 select * into plan from public.fixture_openclaw_v2_plan;
 snap:=public.openclaw_leave_snapshot(repeat('9',64),(plan.draft->>'id')::uuid);
 assert snap->>'fingerprint'<>plan.snapshot->>'fingerprint';
 replay:=public.openclaw_leave_commit(repeat('9',64),repeat('f',64),snap->>'fingerprint',snap->>'draftFingerprint',plan.packet,plan.person,null,'{}',false);
 assert replay=snap->'receipt'->'result' and replay->>'code'='submitted','Fresh-snapshot receipt replay failed after rename';
 begin
  perform public.openclaw_leave_commit(repeat('9',64),repeat('f',64),plan.snapshot->>'fingerprint',snap->>'draftFingerprint',plan.packet,plan.person,null,'{}',false);
  raise exception 'Stale identity snapshot bypassed receipt authorization';
 exception when serialization_failure then null;end;
end$$;
reset role;
rollback;`,encoding:'utf8',env:{PATH:process.env.PATH}});
process.stdout.write(final.stdout??'');process.stderr.write(final.stderr??'');
if(final.status!==0)process.exit(final.status??1);
process.stdout.write('Quoted Confirm: legacy draft across upgrade, ACLs, snapshot names, consent and concurrent exactly-once submission passed\n');
