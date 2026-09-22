// Isolated synthetic database only. No URLs, remote SQL, credentials or emails.
import {readFileSync} from 'node:fs';
import {spawnSync,spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {target,postgresEnv} from '../scripts/local-test-postgres.mjs';
const [socket,database]=process.argv.slice(2);
if(!/^openclaw_leave_test_[0-9]+$/.test(database??'')) {
  throw new Error('Explicit disposable local socket and database required');
}
const env=postgresEnv; // No inherited PGHOST, PGOPTIONS or credentials.
const args=target(socket,database);
const read=path=>readFileSync(path,'utf8');
const extract=(path,start,end)=>{const s=read(path),a=s.indexOf(start),b=s.indexOf(end,a);assert.ok(a>=0&&b>a,path);return s.slice(a,b);};
function sql(input){
  const r=spawnSync('psql',args,{input,encoding:'utf8',env});
  if(r.status!==0)throw new Error(r.stderr??'SQL failed');
  return r.stdout;
}
sql(`do $$begin
 if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
 if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
 if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end$$;`);
sql(read('tests/openclaw-leave-bootstrap.sql')+'\n'+read('tests/openclaw-verified-identity-bootstrap.sql'));
const account='supabase/migrations/20260813051743_portal_account_management.sql';
sql(extract(account,'create function private.is_active_portal_account(', 'create function private.has_current_portal_access(')
  .replace('create function','create or replace function')+'\n'+
  extract(account,'create function private.is_portal_account_admin()', 'create function public.can_manage_portal_accounts()')+'\n'+
  read('supabase/migrations/20260820093000_define_system_portal_account_admin.sql'));
sql(extract('supabase/migrations/20260814112000_hr_employee_directory.sql',
  'create function private.normalise_employee_directory_text(', 'create function public.can_manage_employee_directory()'));
sql(read('supabase/migrations/20260814120000_self_service_employee_profile.sql'));
sql(extract('supabase/migrations/20260818130000_configurable_leave_approval_grants.sql',
  'create function public.submit_my_leave_request(', 'comment on function public.submit_my_leave_request')+'\n'+
  extract('supabase/migrations/20260904140000_historical_leave_import_support.sql',
  'create or replace function private.enforce_leave_request_employment_policy()', 'drop function public.list_leave_workspace_requests')+'\n'+
  'create trigger employment before insert on public.leave_requests for each row execute function private.enforce_leave_request_employment_policy();');
for(const stem of ['20260917045203_openclaw_phone_allowlist','20260917051434_openclaw_phone_country_context',
  '20260917223558_openclaw_leave_bridge','20260918120000_openclaw_self_profile',
  '20260920120000_openclaw_quoted_confirm','20260921150000_openclaw_confirm_only',
  '20260922230000_openclaw_verified_phone_identity']) sql(read(`supabase/migrations/${stem}.sql`));
sql(read('tests/openclaw-verified-identity.sql'));
console.log('PASS SQL: empty enrollment, real self-edit isolation, admin/ACLs, CAS, uniqueness, audit, scope, legacy paths, confirmation and replay');

// Hold a completed revocation uncommitted. Confirmation must wait for the SAME
// advisory lock, then reject the pre-revocation snapshot. No timing-only race.
const holder=spawn('psql',[...args,'-Atq'],{env,stdio:['pipe','pipe','pipe']});
let holderError=''; holder.stderr.on('data',v=>holderError+=v);
const holderDone=new Promise((resolve,reject)=>{holder.on('error',reject);holder.on('close',code=>code===0?resolve():reject(new Error(holderError)));});
const held=new Promise((resolve,reject)=>{
  let out='';holder.stdout.on('data',v=>{out+=v;if(out.includes('REVOCATION_HELD'))resolve();});
  holder.on('error',reject);holder.on('close',()=>reject(new Error('Revocation holder ended early: '+holderError)));
});
holder.stdin.write(`begin;
select set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000099',true);
select set_config('request.jwt.claims','{"is_anonymous":false,"iat":1999999999}',true);
set local role authenticated;
select public.set_openclaw_phone_identity('10000000-0000-4000-8000-000000000001',
 (public.get_openclaw_phone_identity('10000000-0000-4000-8000-000000000001')->>'revision')::uuid,null,'synthetic:race-revoke');
select 'REVOCATION_HELD';\n`);
let waiter;
try {
  await held;
  waiter=spawn('psql',[...args,'-Atq','-c',`set application_name='s01_identity_waiter';
    do $$declare x public.fixture_openclaw_identity_plan%rowtype;begin
    select * into x from public.fixture_openclaw_identity_plan;
    begin
      perform public.openclaw_leave_v3_submit(repeat('9',64),repeat('f',64),x.snapshot->>'fingerprint',x.packet,x.person,x.draft,x.token_hash);
      raise exception 'Stale raced confirmation accepted' using errcode='ZX001';
    exception when serialization_failure then null; end;
    end$$;`],{env});
  let error='';waiter.stderr.on('data',v=>error+=v);
  const completed=new Promise((resolve,reject)=>{waiter.on('error',reject);waiter.on('close',code=>code===0?resolve():reject(new Error(error)));});
  // Wait for PostgreSQL itself to confirm blocking, with a bounded deadline.
  let blocked=false;
  for(let i=0;i<40;i++){
    if(sql("select exists(select 1 from pg_stat_activity where application_name='s01_identity_waiter' and wait_event='advisory');").includes(' t')){blocked=true;break;}
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.ok(blocked,'Confirmation did not synchronize with identity mutation');
  holder.stdin.end('commit;\n');
  await Promise.all([holderDone,completed]);
  sql(`do $$begin
    assert (select count(*)=1 from public.leave_requests),'Race created leave';
    assert (select count(*)=1 from private.leave_notification_outbox),'Race created notification';
    assert not exists(select 1 from private.openclaw_leave_receipts where key=repeat('9',64));
  end$$;`);
  console.log('PASS SQL concurrency: confirmation blocks on registry revocation, rejects stale source after commit, no leave/outbox/receipt');
} finally {
  if(holder.exitCode===null)holder.stdin.end('rollback;\n');
  if(waiter && waiter.exitCode===null)waiter.kill();
}
