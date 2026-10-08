import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {command,createDatabase,sql,target} from '../scripts/local-test-postgres.mjs';

export function runSubscriptionRequestCatalog(socket,group='all') {
  const migration='supabase/migrations/20261008150000_subscription_requests_milestone1.sql';
  const source=readFileSync(migration,'utf8');
  const sourceHash=createHash('sha256').update(source).digest('hex');
  const refresh=source.includes('do $sr_refresh$')?'do $sr_refresh$':'update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;';
  const refreshEnd=source.includes('do $sr_refresh$')?'end $sr_refresh$;':refresh;
  assert.equal(source.split(refresh).length,2,'One exact transition seam');
  const predecessor=`mam_test_sr_catalog_${process.pid}`;
  target(socket,predecessor);
  createDatabase(socket,predecessor);
  sql(socket,predecessor,readFileSync('tests/migrations/0001-supabase-platform.sql','utf8'));
  const history=readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql') && f<path.basename(migration)).sort();
  const pins=history.map(f=>[f,createHash('sha256').update(readFileSync('supabase/migrations/'+f)).digest('hex')]);
  const catalogSource=readFileSync('supabase/migrations/20261006105000_onboarding_credential_review.sql','utf8');
  const start=catalogSource.indexOf('create function pg_temp.onboarding_review_catalog()');
  const end=catalogSource.indexOf('$catalog$;',start)+'$catalog$;'.length;
  assert.ok(start>=0 && end>start);
  const collector=catalogSource.slice(start,end);
  const inputs=[migration,...history.map(f=>'supabase/migrations/'+f),
    'tests/migrations/0001-supabase-platform.sql','tests/migrations/operator-session-platform.sql',
    'tests/migrations/canonical-roles-storage-platform.sql','tests/migrations/canonical-roles-hosted-member-predecessor.sql',
    'tests/migrations/canonical-roles-release-plan.sql','tests/migrations/canonical-roles-release-readback.sql',
    'tests/unified-role-fixture.sql','tests/sql-test-auth.sql','scripts/local-test-postgres.mjs',fileURLToPath(import.meta.url)];
  const hashInputs=()=>inputs.map(p=>({path:path.relative(process.cwd(),path.resolve(p)),sha256:createHash('sha256').update(readFileSync(p)).digest('hex')}));
  const inputPins=hashInputs();
  const proof=mkdtempSync(path.join(socket,'mam-sr-catalog-'));const records=[];
  const save=()=>writeFileSync(path.join(proof,'RESULT.json'),JSON.stringify({source_sha256:sourceHash,inputs:inputPins,records},null,2)+'\n',{mode:0o600});save();
  const dataTables=['auth.users','public.profiles','public.internal_org_people','private.portal_account_admins','private.portal_account_admin_events','private.employee_team_manager_defaults',
    'private.subscription_register','private.subscription_memberships','private.subscription_audit_events','private.subscription_management_grants',
    'private.subscription_management_grant_events','private.subscription_credential_vault','private.subscription_credential_audit_events',
    'private.subscription_credential_access_grants','private.subscription_credential_access_audit_events','private.subscription_credential_grant_changes'];
  const dataCollector=`create function pg_temp.sr_test_data() returns text language plpgsql stable set search_path='' as $data$declare r text;rows jsonb;v jsonb:='{}';begin foreach r in array array[${dataTables.map(t=>"'"+t+"'").join(',')}] loop execute format('select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),''[]''::jsonb) from %s t',r::regclass) into rows;v:=v||jsonb_build_object(r,rows);end loop;return encode(extensions.digest(v::text,'sha256'),'hex');end $data$;`;
  function snapshot(database) {
    return JSON.parse(sql(socket,database,`begin;set local search_path='';${collector}\n${dataCollector}\nselect jsonb_build_object('data',pg_temp.sr_test_data(),'catalog',(select encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(c) order by kind collate "C",object_identity collate "C"),'[]'::jsonb)::text,'sha256'),'hex') from pg_temp.onboarding_review_catalog() c),'actual',private.confirmed_test_purge_schema_hash(),'stored',(select schema_hash from private.confirmed_test_purge_schema where singleton));rollback;`).trim());
  }
  try {
    for(const f of history) {
      if(f==='20261003090000_payroll_operator_session_proof.sql') {
        sql(socket,predecessor,readFileSync('tests/migrations/operator-session-platform.sql','utf8'));
        sql(socket,predecessor,'update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;');
      }
      if(f==='20261006104000_unified_portal_roles.sql') {
        sql(socket,predecessor,readFileSync('tests/migrations/canonical-roles-storage-platform.sql','utf8'));
        sql(socket,predecessor,readFileSync('tests/migrations/canonical-roles-hosted-member-predecessor.sql','utf8'));
        sql(socket,predecessor,'update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;');
        command('psql',[...target(socket,predecessor),'-f','tests/migrations/canonical-roles-release-plan.sql','-f','supabase/migrations/'+f,'-f','tests/migrations/canonical-roles-release-readback.sql']);
      } else sql(socket,predecessor,readFileSync('supabase/migrations/'+f,'utf8'));
    }
    command('psql',[...target(socket,predecessor),'-f','tests/unified-role-fixture.sql']);
    sql(socket,predecessor,"insert into private.employee_team_manager_defaults(company_key,team_name,manager_person_id,configured_by_auth_user_id) values('mam','Operation & Accounts','a1000000-0000-4000-8000-000000000004','a1000000-0000-4000-8000-000000000004');");
    const before=snapshot(predecessor);
    assert.equal(before.actual,before.stored);
    const positive=predecessor+'_positive';
    command('createdb',['-h',socket,'-p','55439','-U','postgres','--template='+predecessor,positive]);
    try {
      sql(socket,positive,source);
      const after=snapshot(positive);assert.equal(after.actual,after.stored);assert.equal(after.data,before.data);
      assert.equal(sql(socket,positive,`select has_function_privilege('authenticated','public.sr_workspace()','EXECUTE') and has_function_privilege('authenticated','public.sr_mutate(uuid,bigint,text,jsonb,text,jsonb)','EXECUTE') and has_function_privilege('authenticated','public.sr_download(uuid,bigint,integer)','EXECUTE') and not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('sr_workspace','sr_mutate','sr_download') and (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('service_role',p.oid,'EXECUTE'))) and not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname in ('subscription_request_config','subscription_requests','subscription_request_events','subscription_request_notifications') and (not c.relrowsecurity or has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') or has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') or has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE')));`).trim(),'t');
      records.push({name:'clean_commit',committed:true,before,after});save();
      assert.equal(sql(socket,positive,"select count(*)=1 and bool_and(singleton and not enabled and approver_user_id is null and approver_person_id is null) from private.subscription_request_config;").trim(),'t');
      console.log('PASS: catalog same-baseline clean positive actually committed');
    } finally {command('dropdb',['-h',socket,'-p','55439','-U','postgres',positive]);}
    const queue=effect=>`create temporary table sr_fault_queue(done boolean);create function pg_temp.sr_fault_handler() returns trigger language plpgsql as $fixture$begin ${effect};return new;end $fixture$;create constraint trigger sr_fixture_deferred after insert on pg_temp.sr_fault_queue deferrable initially deferred for each row execute function pg_temp.sr_fault_handler();set constraints pg_temp.sr_fixture_deferred deferred;insert into pg_temp.sr_fault_queue values(false);`;
    const benignQueue='create temporary table sr_benign_marker(seen boolean);insert into pg_temp.sr_benign_marker values(false);'+queue('update pg_temp.sr_benign_marker set seen=true');
    const cases=[
      ['prefix_function','before_refresh',"create function public.sr_unreviewed() returns boolean language sql security definer as $$select true$$;"],
      ['deferred_pre','before_checks',queue('alter function public.sr_workspace() security invoker')],
      ['benign_pre','before_checks',benignQueue,true],
      ['deferred_post','after_refresh',queue('alter function public.sr_workspace() security invoker')],
      ['benign_post','after_refresh',benignQueue,true],
      ['ledger_cas','before_refresh',"update private.confirmed_test_purge_schema set schema_hash=repeat('0',64) where singleton;"],
      ['ledger_final','after_checks',"alter table private.subscription_requests rename column applicant to sr_unreviewed_applicant;update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;"],
      ['initial_window_security','before_snapshot','alter function pg_catalog.row_number() security definer;'],
      ['initial_window_config','before_snapshot',"alter function pg_catalog.row_number() set search_path=public;"],
      ['initial_enum','before_snapshot',"create type public.sr_unreviewed as enum('synthetic');"],
      ['initial_procedure','before_snapshot',"create procedure public.sr_unreviewed() language plpgsql as $$begin perform 1;end$$;"],
      ['prefix_table','before_checks','create table private.subscription_request_unreviewed(id uuid);grant all on private.subscription_request_unreviewed to authenticated;'],
      ['prefix_before_checks','before_checks',"create function public.sr_unreviewed() returns boolean language sql security definer as $$select true$$;"],
      ['extra_view','before_checks','create view public.sr_unreviewed as select 1 as synthetic;'],
      ['extra_enum','before_checks',"create type public.sr_unreviewed as enum('synthetic');"],
      ['extra_domain','before_checks','create domain public.sr_unreviewed as bigint check(value>=0);'],
      ['extra_procedure','before_checks',"create procedure public.sr_unreviewed() language plpgsql as $$begin perform 1;end$$;"],
      ['extra_aggregate','before_checks',"create aggregate public.sr_unreviewed(*) (sfunc=pg_catalog.int8inc,stype=bigint,initcond='0');"],
      ['routine_acl','before_checks','grant execute on function public.sr_workspace() to anon;'],
      ['routine_owner','before_checks','alter function public.sr_workspace() owner to authenticated;'],
      ['routine_config','before_checks','alter function public.sr_workspace() reset all;'],
      ['routine_strict','before_checks','alter function public.sr_workspace() strict;'],
      ['routine_body','before_checks',"create or replace function public.sr_workspace() returns jsonb language sql stable security definer set search_path='' as $$select '{}'::jsonb$$;"],
      ['table_acl','before_checks','grant select on private.subscription_requests to authenticated;'],
      ['table_rls','before_checks','alter table private.subscription_requests disable row level security;'],
      ['column_default','before_checks',"alter table public.profiles alter column full_name set default 'synthetic drift';"],
      ['default_acl','before_checks','alter default privileges in schema private grant execute on functions to authenticated;'],
      ['schema_acl','before_checks','grant create on schema private to authenticated;'],
      ['role_security','before_checks','alter role anon bypassrls;'],
      ['role_membership','before_checks','grant authenticated to anon;'],
      ['trigger_disabled','before_checks','alter table private.subscription_request_events disable trigger subscription_request_events_immutable;'],
      ['trigger_predicate','before_checks','drop trigger subscription_request_events_immutable on private.subscription_request_events;create trigger subscription_request_events_immutable before update or delete on private.subscription_request_events for each row when(false) execute function private.sr_immutable();'],
      ['trigger_columns','before_checks','drop trigger subscription_request_events_immutable on private.subscription_request_events;create trigger subscription_request_events_immutable before update of version or delete on private.subscription_request_events for each row execute function private.sr_immutable();'],
      ['existing_data','before_checks',"update public.profiles set updated_at=clock_timestamp() where id='a1000000-0000-4000-8000-000000000004';"],
      ['configuration_seed','before_checks',"update private.subscription_request_config set enabled=true,approver_user_id='a1000000-0000-4000-8000-000000000004',approver_person_id='a1000000-0000-4000-8000-000000000004';"],
      ['main221_before_getter_acl','before_snapshot','grant execute on function public.get_employee_team_manager_default(text,text) to anon;'],
      ['main221_before_creator_security','before_snapshot','alter function public.create_employee_directory_record(text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,text,text,text,text,text[],integer) security invoker;'],
      ['main221_before_config_default','before_snapshot','alter table private.employee_team_manager_defaults alter column version set default 2;'],
      ['main221_before_config_rls','before_snapshot','alter table private.employee_team_manager_defaults disable row level security;'],
      ['main221_before_type_acl','before_snapshot','grant usage on type private.employee_team_manager_defaults to anon;'],
      ['main221_after_config_data','before_checks',"update private.employee_team_manager_defaults set version=version+1 where company_key='mam';"],
      ['main221_after_getter_acl','before_checks','grant execute on function public.get_employee_team_manager_default(text,text) to anon;'],
      ['main221_after_creator_security','before_checks','alter function public.create_employee_directory_record(text,text,text,text,text,text,text,uuid,text,date,date,date,text,boolean,text,text,text,text,text[],integer) security invoker;'],
      ['main221_deferred_config_pre','before_checks',queue("update private.employee_team_manager_defaults set version=version+1 where company_key='mam'")],
      ['main221_deferred_config_post','after_refresh',queue("update private.employee_team_manager_defaults set version=version+1 where company_key='mam'")]
    ];
    const selected=group==='all'?cases:cases.filter(c=>group==='main221'?c[0].startsWith('main221_'):c[0]===group);assert.ok(selected.length>0);
    assert.equal(new Set(selected.map(c=>c[0])).size,selected.length);
    for(const [name,phase,fault,benign=false] of selected) {
      const database=predecessor+'_'+name;
      command('createdb',['-h',socket,'-p','55439','-U','postgres','--template='+predecessor,database]);
      try {
        const seam=phase==='before_snapshot'?'create temporary table sr_catalog_before':phase==='before_refresh'?refresh:phase==='after_refresh'?refreshEnd:'end $sr_assert$;';
        let input=source.replace(seam,()=>phase.startsWith('before_') && phase!=='before_checks'?fault+'\n'+seam:seam+'\n'+fault);
        if(phase==='after_checks') {const marker='select pg_temp.sr_assert_catalog();';const end=source.lastIndexOf(marker)+marker.length;assert.ok(end>marker.length);input=source.slice(0,end)+'\n'+fault+source.slice(end);}
        if(benign) input+="select 'BENIGN_DEFERRED_EXECUTED' from pg_temp.sr_benign_marker where seen;";
        const queryHash=createHash('sha256').update(input).digest('hex');const queryPath=path.join(proof,name+'.sql');writeFileSync(queryPath,input,{mode:0o600});
        let result='committed';let stdout='';
        try {stdout=command('psql',[...target(socket,database),'-v','VERBOSITY=verbose','-Atq','-f',queryPath],{maxBuffer:16*1024*1024});} catch(error) {result=error.message;}
        const after=snapshot(database);
        if(benign) {assert.equal(result,'committed');assert.ok(stdout.includes('BENIGN_DEFERRED_EXECUTED'));assert.equal(after.actual,after.stored);assert.equal(after.data,before.data);console.log('PASS: '+name+' queued effect actually executed and committed');}
        else {assert.ok(result.includes('55000:'),'Fault '+name+' must be denied, not '+result);assert.deepEqual(after,before,'Failed transition must completely roll back catalog, ledger and protected data');assert.equal(sql(socket,database,"select to_regclass('private.subscription_requests') is null and to_regprocedure('public.sr_unreviewed()') is null;").trim(),'t');console.log('PASS: '+name+' rejected with complete rollback');}
        records.push({name,phase,query_sha256:queryHash,query_path:queryPath,committed:benign,sqlstate:benign?null:'55000',before,after});save();
      } finally {command('dropdb',['-h',socket,'-p','55439','-U','postgres',database]);}
    }
    assert.deepEqual(hashInputs(),inputPins);
    console.log('PASS: subscription request catalog '+selected.length+' cases; proof='+path.join(proof,'RESULT.json'));
    assert.equal(createHash('sha256').update(readFileSync(migration)).digest('hex'),sourceHash);
    assert.deepEqual(history.map(f=>[f,createHash('sha256').update(readFileSync('supabase/migrations/'+f)).digest('hex')]),pins);
  } finally {command('dropdb',['-h',socket,'-p','55439','-U','postgres',predecessor]);}
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) runSubscriptionRequestCatalog(process.argv[2],process.argv[3]);
