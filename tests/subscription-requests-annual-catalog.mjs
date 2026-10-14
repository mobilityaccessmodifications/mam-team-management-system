import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {command,sql,target} from '../scripts/local-test-postgres.mjs';

// Independent protected-row contract. Never derive this list from the core.
const tables=['auth.users','private.employee_team_manager_defaults','private.leave_bank_adoption_receipts','private.leave_bank_sources','private.leave_payroll_calendars','private.portal_account_admin_events','private.portal_account_admins','private.subscription_audit_events','private.subscription_credential_access_audit_events','private.subscription_credential_access_grants','private.subscription_credential_audit_events','private.subscription_credential_grant_changes','private.subscription_credential_vault','private.subscription_management_grant_events','private.subscription_management_grants','private.subscription_memberships','private.subscription_register','public.internal_org_people','public.profiles'];
const person='a9000000-0000-4000-8000-000000000090';
const receipt='b9000000-0000-4000-8000-000000000090';
const sourceID='b9000000-0000-4000-8000-000000000091';
const hash=value=>createHash('sha256').update(value).digest('hex');
const quote=value=>"'"+value.replaceAll("'","''")+"'";

export function runSubscriptionRequestsAnnualCatalog(socket,{predecessor,phase='green',outputDir,runTag='03',resumeControl=false,selection='data'}={}) {
  assert.ok(predecessor&&['red','green'].includes(phase));
  assert.match(runTag,/^[0-9]{2}$/);
  assert.ok(['data','metadata','benign','all'].includes(selection));
  target(socket,predecessor);
  const major=sql(socket,predecessor,"select current_setting('server_version_num')::integer/10000;").trim();
  assert.ok(['16','17'].includes(major));
  const base='mam_test_sr_annual_protected_'+phase+'_'+runTag;
  const source=readFileSync('supabase/migrations/20261008160000_subscription_requests_milestone1.sql','utf8');
  const start=source.indexOf('create function pg_temp.sr_inventory()');
  const end=source.indexOf('$catalog$;',start)+'$catalog$;'.length;
  assert.ok(start>=0&&end>start);
  const collector=source.slice(start,end);
  const fileSQL=(database,body,name)=>{
    const file=path.join(socket,name+'-'+runTag+'.sql');writeFileSync(file,body,{flag:'wx',mode:0o600});
    return command('psql',[...target(socket,database),'-v','VERBOSITY=verbose','-Atq','-f',file],{maxBuffer:32*1024*1024});
  };
  const snapshot=database=>{
    const entries=tables.map(table=>quote(table)+",(select coalesce(jsonb_agg(v order by v::text collate \"C\"),'[]') from (select to_jsonb(t) v from "+table+' t) r)').join(',');
    const query="begin;set local search_path='';"+collector+"\nselect jsonb_build_object('catalog',encode(extensions.digest(convert_to((select coalesce(jsonb_agg(to_jsonb(c) order by c.kind collate \"C\",c.object_identity collate \"C\"),'[]')::text from pg_temp.sr_inventory() c),'UTF8'),'sha256'),'hex'),'data',jsonb_build_object("+entries+"),'ledger',(select coalesce(jsonb_agg(to_jsonb(t) order by t.singleton),'[]') from private.confirmed_test_purge_schema t),'featureAbsent',to_regclass('private.subscription_requests') is null);rollback;";
    const file=path.join(socket,'sr-annual-observe.sql');writeFileSync(file,query,{mode:0o600});
    return JSON.parse(command('psql',[...target(socket,database),'-Atq','-f',file],{maxBuffer:32*1024*1024}));
  };
  const clone=(name,template=base)=>{
    target(socket,name);target(socket,template);
    command('createdb',['-h',socket,'-p','55439','-U','postgres','--template='+template,name]);
  };
  if(!resumeControl) {
  clone(base,predecessor);
  sql(socket,base,`insert into public.internal_org_people(id,full_name,position_title,company_key,is_active) values('${person}','Synthetic annual guard person','Synthetic','mam',true);
    insert into private.leave_bank_adoption_receipts(id,owner_key,plan_hash,source_count,operator_role) values('${receipt}','sr-annual-guard-${major}-${phase}',repeat('9',64),1,'postgres');
    insert into private.leave_bank_sources(id,person_id,leave_kind,hours,report_date,covered_service_through,source_kind,source_fingerprint,adoption_receipt_id,included_usage,note,operator_role) values('${sourceID}','${person}','annual',42,'2026-10-07','2026-10-07','manual_snapshot',repeat('9',64),'${receipt}','[]'::jsonb,'Synthetic annual guard source','postgres');
    insert into private.leave_payroll_calendars(person_id,calendar_key) values('${person}','victoria');`);
  }
  const before=snapshot(base);
  for(const table of tables.slice(2,5)) assert.ok(before.data[table].length>0,'Annual fixture must be nonempty: '+table);
  const results=[];
  const positive='mam_test_sr_annual_positive_'+phase+'_'+runTag;
  if(resumeControl) assert.equal(readFileSync(path.join(socket,'sr-annual-positive-'+phase+'-'+runTag+'.sql'),'utf8'),source);
  else {clone(positive);fileSQL(positive,source,'sr-annual-positive-'+phase);}
  const after=snapshot(positive);
  assert.deepEqual(after.data,before.data,'COMMIT changed protected rows');
  assert.equal(after.featureAbsent,false);
  assert.equal(sql(socket,positive,"select (select count(*)=1 and bool_and(not enabled and approver_user_id is null and approver_person_id is null) from private.subscription_request_config) and (select count(*)=0 from private.subscription_requests) and (select count(*)=0 from private.subscription_request_events) and (select count(*)=0 from private.subscription_request_notifications) and private.confirmed_test_purge_schema_hash()=(select schema_hash from private.confirmed_test_purge_schema where singleton);").trim(),'t');
  results.push({id:'annual_same_baseline_commit',status:'PASS',sourceSha256:hash(source),querySha256:hash(source),actualCOMMIT:true,positiveControlReconciledNotReexecuted:resumeControl,protectedDataEqual:true,featureDisabled:true});
  const mutations={
    calendar:`update private.leave_payroll_calendars set calendar_key='none' where person_id='${person}';`,
    source:`insert into private.leave_bank_sources(id,person_id,leave_kind,hours,report_date,covered_service_through,source_kind,source_fingerprint,adoption_receipt_id,included_usage,note,operator_role) values('b9000000-0000-4000-8000-000000000092','${person}','annual',43,'2026-10-07','2026-10-07','manual_snapshot',repeat('8',64),'${receipt}','[]'::jsonb,'Synthetic injected source','postgres');`,
    receipt:"insert into private.leave_bank_adoption_receipts(id,owner_key,plan_hash,source_count,operator_role) values('b9000000-0000-4000-8000-000000000093','sr-injected-receipt',repeat('8',64),1,'postgres');",
  };
  const assertSeam='end $sr_assert$;';
  const refreshSeam='end $sr_refresh$;';
  assert.equal(source.split(assertSeam).length,2);assert.equal(source.split(refreshSeam).length,2);
  const dataCases=phase==='red'?[{id:'annual_direct_calendar_before_checks',seam:assertSeam,effect:mutations.calendar}]:Object.entries(mutations).flatMap(([name,effect])=>[
    {id:'annual_direct_'+name+'_before_checks',seam:assertSeam,effect},
    {id:'annual_direct_'+name+'_after_refresh',seam:refreshSeam,effect},
    {id:'annual_deferred_'+name+'_before_checks',seam:assertSeam,effect,deferred:true},
    {id:'annual_deferred_'+name+'_after_refresh',seam:refreshSeam,effect,deferred:true},
  ]);
  const metadataEffects={
    function_security:'alter function private.leave_bank_basis(uuid,text) security invoker;',
    function_acl:'grant execute on function private.leave_bank_basis(uuid,text) to anon;',
    function_owner:'alter function private.leave_bank_basis(uuid,text) owner to authenticated;',
    function_config:"alter function private.leave_bank_basis(uuid,text) set search_path='public';",
    table_rls:'alter table private.leave_bank_sources disable row level security;',
    table_acl:'grant select on private.leave_bank_sources to anon;',
    row_type_default:"update pg_catalog.pg_type set typdefault='synthetic type drift' where oid='private.leave_bank_sources'::regtype;",
    array_type_default:"update pg_catalog.pg_type set typdefault='synthetic array drift' where oid='private._leave_bank_sources'::regtype;",
    index:'drop index private.leave_bank_sources_latest;',
    column_default:"alter table private.leave_bank_sources alter column note set default 'Synthetic altered default';",
    constraint:'alter table private.leave_bank_sources drop constraint leave_bank_sources_person_id_fkey;',
    trigger_enabled:'alter table private.leave_bank_sources disable trigger leave_bank_sources_immutable;',
  };
  const metadataCases=Object.entries(metadataEffects).flatMap(([name,effect])=>[
    {id:'annual_metadata_'+name+'_before_capture',seam:'create temporary table sr_catalog_before',effect,insertBefore:true},
    {id:'annual_metadata_'+name+'_final',seam:refreshSeam,effect},
  ]);
  const benignCases=[{id:'annual_benign_deferred_drain',seam:refreshSeam,effect:`update private.leave_payroll_calendars set calendar_key=calendar_key where person_id='${person}';perform set_config('mam.fixture.sr_annual_effect','executed',true);`,deferred:true,benign:true}];
  const cases=phase==='red'?dataCases:selection==='metadata'?metadataCases:selection==='benign'?benignCases:selection==='all'?[...dataCases,...metadataCases,...benignCases]:dataCases;
  assert.equal(new Set(cases.map(test=>test.id)).size,cases.length);
  let caseNumber=0;
  for(const test of cases) {
    const database='mam_test_sr_annual_'+selection+'_'+(++caseNumber)+'_'+phase+'_'+runTag;clone(database);
    let effect=test.effect;
    if(test.deferred) effect="create temporary table sr_annual_effect(value integer) on commit drop;create function pg_temp.sr_annual_effect() returns trigger language plpgsql set search_path='' as $effect$ begin "+effect+" return new;end;$effect$;create constraint trigger sr_annual_effect after insert on sr_annual_effect deferrable initially deferred for each row execute function pg_temp.sr_annual_effect();insert into sr_annual_effect values(1);";
    assert.equal(source.split(test.seam).length,2);
    let candidate=source.replace(test.seam,test.insertBefore?effect+'\n'+test.seam:test.seam+'\n'+effect);
    if(test.benign) candidate=candidate.replace(/\ncommit;\s*$/,"\ndo $fixture_assert$ begin if current_setting('mam.fixture.sr_annual_effect',true) is distinct from 'executed' then raise exception 'Owned benign deferred effect was not executed';end if;end $fixture_assert$;\ncommit;\n");
    let error;
    try {fileSQL(database,candidate,test.id+'-'+phase);} catch(e) {error=e.message;}
    const observed=snapshot(database);
    const rejected=error?.includes('55000:')??false;
    const rollback=JSON.stringify(observed)===JSON.stringify(before);
    const result={id:test.id,status:(test.benign?!error&&JSON.stringify(observed.data)===JSON.stringify(before.data)&&!observed.featureAbsent:rejected&&rollback)?'PASS':'FAIL',actualSQLSTATE:rejected?'55000':null,committedWithoutExpectedDenial:!error,completeRawRollback:rollback,sourceSha256:hash(source),querySha256:hash(candidate),actualError:error??null};
    if(outputDir) writeFileSync(path.join(outputDir,'ANNUAL-PG'+major+'-'+selection.toUpperCase()+'-'+test.id+'.sql'),candidate,{flag:'wx',mode:0o600});
    results.push(result);console.log(result.status+': '+test.id+' actualSQLSTATE='+(result.actualSQLSTATE??'none'));
  }
  const report={phase,major,selection,newExecutedCases:cases.length,inheritedPositiveControl:resumeControl,sourceSha256:hash(source),beforeCatalogHash:before.catalog,beforeDataHash:hash(JSON.stringify(before.data)),protectedTables:tables.length,nonemptyAnnualTables:3,uniqueCriteria:results.length,passed:results.filter(row=>row.status==='PASS').length,failed:results.filter(row=>row.status==='FAIL').length,results,hostedProof:false};
  if(outputDir) writeFileSync(path.join(outputDir,'ANNUAL-PG'+major+'-'+(selection==='data'?'DATA':selection.toUpperCase())+'-'+phase.toUpperCase()+'.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  assert.equal(report.failed,0,'Annual protected-state guards failed; original evidence retained');
  console.log('PASS: annual data group PG'+major+' '+report.passed+'/'+report.uniqueCriteria+' actual native cases');
  return report;
}
