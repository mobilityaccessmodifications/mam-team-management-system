import {readFileSync,readdirSync,writeFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {startCluster,stopCluster,createDatabase,command,sql,target,postgresEnv} from '../scripts/local-test-postgres.mjs';
const evidence=mkdtempSync(path.join(os.tmpdir(),'mam-role-thirdround-'));
const file=process.argv[2]??'supabase/migrations/20261006104000_unified_portal_roles.sql';
const source=readFileSync(file,'utf8'),sha=createHash('sha256').update(source).digest('hex');
writeFileSync(path.join(evidence,'candidate.sql'),source);
const socket=startCluster(),pre='mam_test_thirdround_pre',results=[];
const anchor='update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;';
const snapshot=`select jsonb_build_object('hash',private.confirmed_test_purge_schema_hash(),'baseline',(select schema_hash from private.confirmed_test_purge_schema),'roles',(select jsonb_agg(to_jsonb(p) order by id) from public.profiles p),'auth',(select jsonb_agg(to_jsonb(u) order by id) from auth.users u),'receipts',(select jsonb_agg(to_jsonb(r) order by id) from private.confirmed_test_identity_purges r));`;
const digest=db=>createHash('sha256').update(sql(socket,db,snapshot)).digest('hex');
let counter=0;
function probe(label,setup,body,expectedDenied=true){
 const db='mam_test_thirdround_'+(++counter);command('createdb',['-h',socket,'-p','55439','-U','postgres','--template='+pre,db]);
 try{
  if(setup)sql(socket,db,setup);
  const before=digest(db);let denied=false,code=null;
  const generated=path.join(evidence,label+'.sql');writeFileSync(generated,body);
  try{command('psql',[...target(socket,db),'-v','VERBOSITY=verbose','-Atq','-f',generated],{maxBuffer:16*1024*1024});}catch(e){denied=true;code=e.message.match(/ERROR:\s+(\w+):/)?.[1]??'unknown'; if(code==='unknown'||label.startsWith('deferred')) console.log(e.message.slice(0,1200));}
  const unchanged=digest(db)===before;
  const absent=sql(socket,db,"select to_regprocedure('public.get_portal_role_capabilities(uuid)') is null;").trim()==='t';
  const passed=expectedDenied?denied&&code==='55000'&&unchanged&&absent:!denied;
  results.push({label,passed,denied,code,unchanged,absent});console.log(`${passed?'PASS':'FAIL'} ${label} denied=${denied} code=${code} rollback=${unchanged&&absent}`);
 }finally{command('dropdb',['-h',socket,'-p','55439','-U','postgres',db]);}
}
try{
 createDatabase(socket,pre);sql(socket,pre,readFileSync('tests/migrations/0001-supabase-platform.sql','utf8'));
 const history=readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')&&f<path.basename(file)).sort();
 writeFileSync(path.join(evidence,'history.json'),JSON.stringify(history.map(f=>[f,createHash('sha256').update(readFileSync('supabase/migrations/'+f)).digest('hex')]),null,2));
 for(const f of history)sql(socket,pre,readFileSync('supabase/migrations/'+f,'utf8'));
 const collectorStart=source.indexOf('create function pg_temp.unified_role_transition_catalog()');
 assert.notEqual(collectorStart,-1);
 const collector=source.slice(collectorStart,source.indexOf('$catalog$;',collectorStart)+'$catalog$;'.length);
 probe('pg_catalog_domain_constraint_metadata','',`begin; ${collector}
 create domain pg_catalog.catalog_domain_probe as text constraint synthetic_check check (value <> 'synthetic-a');
 create temp table domain_before as select * from pg_temp.unified_role_transition_catalog() where object_identity like '%catalog_domain_probe%';
 do $$begin if (select count(*) from domain_before where kind='constraint')<>1 then raise exception 'Domain constraint missing from collector' using errcode='55000'; end if; end$$;
 alter domain pg_catalog.catalog_domain_probe drop constraint synthetic_check;
 alter domain pg_catalog.catalog_domain_probe add constraint synthetic_check check (value <> 'synthetic-b');
 do $$begin if not exists(select 1 from pg_temp.unified_role_transition_catalog() current_row join domain_before before_row using(kind,object_identity)
  where current_row.kind='constraint' and current_row.definition is distinct from before_row.definition) then
   raise exception 'Domain CHECK expression change invisible' using errcode='55000'; end if; end$$;
 rollback;`,false);
 for(const [label,fault] of [
  ['unconstrained_domain','create domain private.unreviewed_domain as text;'],
  ['enum',"create type private.unreviewed_enum as enum ('synthetic');"],
  ['rewrite','create rule unreviewed_rule as on update to private.subscription_management_grant_events do also select 1;'],
 ])for(const phase of ['pre','post'])probe(phase+'_'+label,'',source.replace(anchor,phase==='pre'?fault+'\n'+anchor:anchor+'\n'+fault));
 for(const [label,fault]of [
  ['initial_pg_catalog_domain',"create domain pg_catalog.unreviewed_domain as text check (value <> 'synthetic');"],
  ['initial_domain','create domain private.unreviewed_domain as text;'],
  ['initial_enum',"create type private.unreviewed_enum as enum ('synthetic');"],
  ['initial_rewrite','create rule unreviewed_rule as on update to private.portal_account_admin_events do also select 1;'],
 ])probe(label,fault,source);
 const fixture=`create function private.thirdround_fault() returns trigger language plpgsql as $$begin if current_setting('mam.thirdround_fault',true)='armed' then update private.confirmed_test_purge_schema set schema_hash='synthetic_late_fault' where singleton; end if; return null; end$$;
 create constraint trigger thirdround_fault after update on private.confirmed_test_purge_schema deferrable initially deferred for each row when (new.schema_hash is distinct from 'synthetic_late_fault') execute function private.thirdround_fault();
 update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;`;
 probe('deferred_baseline',fixture,`create or replace function private.thirdround_fault() returns trigger language plpgsql as $$begin if current_setting('mam.thirdround_fault',true)='armed' then update private.confirmed_test_purge_schema set schema_hash='synthetic_late_fault' where singleton; end if; return null; end$$; set mam.thirdround_fault='armed';\n`+source);
 const identitySeed=`insert into auth.users(id,email,email_confirmed_at) values('b1000000-0000-4000-8000-000000000001','synthetic-thirdround@example.test',now());
 insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after) values('b1000000-0000-4000-8000-000000000001','Synthetic thirdround P0','system_admin','synthetic-thirdround@example.test',now()-interval '1 day');`;
 const syntheticActor=`select set_config('request.jwt.claim.sub','b1000000-0000-4000-8000-000000000001',false);select set_config('request.jwt.claims',jsonb_build_object('sub','b1000000-0000-4000-8000-000000000001','iat',extract(epoch from clock_timestamp())::bigint,'is_anonymous',false)::text,false);`;
 for(const [label,fault] of [
  ['auth_data',"update auth.users set email='synthetic-late@example.test';"],
  ['p0_data',syntheticActor+"update public.profiles set updated_at=clock_timestamp();"],
 ])for(const phase of ['pre','post'])probe(phase+'_'+label,identitySeed,source.replace(anchor,phase==='pre'?fault+'\n'+anchor:anchor+'\n'+fault));
 for(const [label,fault] of [
  ['auth',"update auth.users set email='synthetic-deferred@example.test';"],
  ['p0',"update public.profiles set updated_at=clock_timestamp();"],
 ]){
  const fixture=identitySeed+`create function private.thirdround_fault() returns trigger language plpgsql as $$begin if current_setting('mam.thirdround_fault',true)='armed' then ${fault} end if; return null; end$$;
   create constraint trigger thirdround_fault after update on private.confirmed_test_purge_schema deferrable initially deferred for each row execute function private.thirdround_fault();
   update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;`;
  probe('deferred_'+label,fixture,syntheticActor+"set mam.thirdround_fault='armed';\n"+source);
 }
 probe('valid','',source,false);
 writeFileSync(path.join(evidence,'results.json'),JSON.stringify({sha,results},null,2));
 console.log('EVIDENCE '+evidence);
 assert.equal(results.filter(r=>!r.passed).length,0,'Every thirdround transition blocker rejected atomically');
}finally{
 const pid=Number(readFileSync(socket+'/data/postmaster.pid','utf8').split('\n')[0]);stopCluster(socket);
 const status=spawnSync('pg_ctl',['-D',socket+'/data','status'],{env:postgresEnv});let alive=false;try{process.kill(pid,0);alive=true;}catch{}
 assert.equal(status.status,3);assert.equal(alive,false);rmSync(socket,{recursive:true,force:true});
 writeFileSync(path.join(evidence,'cleanup.json'),JSON.stringify({socket,pid,status:status.status,alive,removed:!existsSync(socket)},null,2));
}
