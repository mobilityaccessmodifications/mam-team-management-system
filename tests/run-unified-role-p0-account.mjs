import {readFileSync,readdirSync,writeFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {startCluster,stopCluster,createDatabase,command,sql,target,postgresEnv} from '../scripts/local-test-postgres.mjs';
import {runP0ActionBoundary} from './helpers/unified-role-p0-action-boundary.mjs';
const evidence=mkdtempSync(path.join(os.tmpdir(),'mam-role-p0-thirdround-'));
const file=process.argv[2]??'supabase/migrations/20261006104000_unified_portal_roles.sql';
const source=readFileSync(file,'utf8'),sha=createHash('sha256').update(source).digest('hex');
const socket=startCluster(),pre='mam_test_p0_pre',results=[];let count=0;
const id=n=>`a1000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const actor=(n,role='authenticated')=>`set local role ${role};select set_config('request.jwt.claim.sub','${n?id(n):''}',true);select set_config('request.jwt.claims',jsonb_build_object('sub',${n?`'${id(n)}'`:'null'},'iat',extract(epoch from clock_timestamp())::bigint,'is_anonymous',false,'role','${role}')::text,true);`;
const snapshot=`select jsonb_build_object('profiles',(select jsonb_agg(to_jsonb(p) order by id) from public.profiles p),'auth',(select jsonb_agg(to_jsonb(u) order by id) from auth.users u),'people',(select jsonb_agg(to_jsonb(p) order by id) from public.internal_org_people p),'resets',(select jsonb_agg(to_jsonb(c) order by auth_user_id) from private.portal_password_reset_claims c),'status',(select jsonb_agg(to_jsonb(c) order by auth_user_id) from private.portal_account_status_change_claims c),'audit',(select jsonb_agg(to_jsonb(c) order by id) from private.portal_account_admin_events c),'history',(select jsonb_agg(to_jsonb(c) order by id) from private.employee_directory_audit_events c),'credentials',(select jsonb_agg(to_jsonb(c) order by id) from private.employee_onboarding_credentials c),'credential_events',(select jsonb_agg(to_jsonb(c) order by id) from private.employee_onboarding_credential_events c),'administrators',(select jsonb_agg(to_jsonb(c) order by auth_user_id) from private.portal_account_admins c));`;
const digest=db=>createHash('sha256').update(sql(socket,db,snapshot)).digest('hex');
function probe(label,call,options={}){
 const db='mam_test_p0_'+(++count);command('createdb',['-h',socket,'-p','55439','-U','postgres','--template='+pre,db]);
 try{
  if(options.setup){
   const hasGuard=sql(socket,db,"select exists(select 1 from pg_trigger where tgname='aa_system_admin_account_target' and tgrelid='private.portal_password_reset_claims'::regclass);").trim()==='t';
   sql(socket,db,(hasGuard?'alter table private.portal_password_reset_claims disable trigger aa_system_admin_account_target;':'')+options.setup+(hasGuard?'alter table private.portal_password_reset_claims enable trigger aa_system_admin_account_target;':''));
  }
  const before=digest(db);let denied=false,code=null;
  const generated=path.join(evidence,label+'.sql');writeFileSync(generated,`begin;${actor(options.actor??4,options.role??'authenticated')}${call}commit;`);
  try{command('psql',[...target(socket,db),'-v','VERBOSITY=verbose','-Atq','-f',generated],{maxBuffer:16*1024*1024});}catch(e){denied=true;code=e.message.match(/ERROR:\s+(\w+):/)?.[1]??'unknown';}
  const unchanged=digest(db)===before;
  const passed=options.allow?!denied:denied&&unchanged&&['42501','40001','23503'].includes(code);
  results.push({label,passed,denied,code,unchanged});console.log(`${passed?'PASS':'FAIL'} ${label} denied=${denied} code=${code} unchanged=${unchanged}`);
 }finally{command('dropdb',['-h',socket,'-p','55439','-U','postgres',db]);}
}
try{
 createDatabase(socket,pre);sql(socket,pre,readFileSync('tests/migrations/0001-supabase-platform.sql','utf8'));
 for(const f of readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')&&f<path.basename(file)).sort())sql(socket,pre,readFileSync('supabase/migrations/'+f,'utf8'));
 sql(socket,pre,source);command('psql',[...target(socket,pre),'-f','tests/unified-role-concurrency-setup.sql']);
 for(const n of [5,9]){
  probe('admin_login_'+n,`select public.update_portal_login('${id(n)}','${id(n)}','synthetic-renamed@example.test',1);`);
  probe('admin_begin_reset_'+n,`select public.begin_portal_password_reset('${id(n)}','${id(n)}',1);`);
  probe('admin_begin_status_'+n,`select public.begin_portal_account_status_change('${id(n)}','${id(n)}',false,1);`);
  probe('admin_old_setter_'+n,`select public.set_portal_account_admin('${id(n)}',true);`);
  probe('p0_old_setter_'+n,`select public.set_portal_account_admin('${id(n)}',true);`,{actor:9});
  probe('service_raw_profile_'+n,`update public.profiles set login_name='synthetic-service@example.test',account_version=account_version+1 where id='${id(n)}';`,{role:'service_role',actor:0});
  probe('admin_raw_profile_'+n,`update public.profiles set login_name='synthetic-admin@example.test',account_version=account_version+1 where id='${id(n)}';`);
  probe('service_raw_claim_'+n,`insert into private.portal_password_reset_claims(auth_user_id,person_id,reset_token,claimed_by,claimed_account_version)values('${id(n)}','${id(n===9?1:n)}',gen_random_uuid(),'${id(4)}',1);`,{role:'service_role',actor:0});
 }
 probe('admin_old_setter_employee',`select public.set_portal_account_admin('${id(1)}',true);`);
 probe('service_old_setter_employee',`select public.set_portal_account_admin('${id(1)}',true);`,{role:'service_role',actor:0});
 probe('p0_old_setter_employee',`select public.set_portal_account_admin('${id(1)}',true);`,{actor:9,allow:true});
 probe('service_promote_system_admin',`update public.profiles set app_role='system_admin' where id='${id(4)}';`,{role:'service_role',actor:0});
 probe('admin_archive_p0',`select public.archive_employee_directory_record('${id(5)}',1,1,current_date,'Other');`);
 probe('admin_old_enabled_p0',`select public.set_portal_account_enabled('${id(5)}','${id(5)}',false,1);`);
 probe('admin_create_existing_p0',`select public.create_portal_account('${id(1)}','${id(9)}','synthetic-created@example.test','employee',1);`);
 const seed=`begin;${actor(9)}select public.begin_portal_password_reset('${id(5)}','${id(5)}',1);commit;`;
 const resetToken=`(select reset_token from private.portal_password_reset_claims where auth_user_id='${id(5)}')`;
 const seededDb='mam_test_p0_seeded';command('createdb',['-h',socket,'-p','55439','-U','postgres','--template='+pre,seededDb]);
 sql(socket,seededDb,seed);const token=sql(socket,seededDb,`select reset_token from private.portal_password_reset_claims where auth_user_id='${id(5)}';`).trim();
 command('dropdb',['-h',socket,'-p','55439','-U','postgres',seededDb]);
 const claimSeed=`insert into private.portal_password_reset_claims(auth_user_id,person_id,reset_token,claimed_by,claimed_account_version)values('${id(5)}','${id(5)}','${token}','${id(4)}',1);`;
 probe('admin_finalise_p0',`select public.finalise_portal_password_reset('${id(5)}','${id(5)}','${token}');`,{setup:claimSeed});
 probe('p0_login_linked',`select public.update_portal_login('${id(5)}','${id(5)}','synthetic-legitimate@example.test',1);`,{actor:9,allow:true});
 probe('p0_status_linked',`select public.begin_portal_account_status_change('${id(5)}','${id(5)}',false,1);`,{actor:9,allow:true});
 probe('p0_begin_reset_linked',`select public.begin_portal_password_reset('${id(5)}','${id(5)}',1);`,{actor:9,allow:true});
 probe('admin_begin_reset_employee',`select public.begin_portal_password_reset('${id(1)}','${id(1)}',1);`,{allow:true});
 for(const n of [5,9])for(const action of ['reset','toggle','create','archive']){
  const db='mam_test_p0_action_'+(++count);command('createdb',['-h',socket,'-p','55439','-U','postgres','--template='+pre,db]);
  try{
   const before=digest(db),actual=await runP0ActionBoundary(socket,db,id(4),id(n),action),unchanged=digest(db)===before;
   const passed=actual.results.length===1&&actual.results.every(r=>r.passed)&&unchanged;
   results.push({label:'action_'+action+'_'+n,passed,authCalls:actual.authCalls,unchanged,calls:actual.calls});
   writeFileSync(path.join(evidence,'action-'+action+'-'+n+'-pins.json'),JSON.stringify(actual.pins,null,2));
   console.log(`${passed?'PASS':'FAIL'} actual ${action} target=${n} Auth=${actual.authCalls} unchanged=${unchanged}`);
  }finally{command('dropdb',['-h',socket,'-p','55439','-U','postgres',db]);}
 }
 const raceDb='mam_test_p0_legacy_setter_race',raceWorkers=[];
 command('createdb',['-h',socket,'-p','55439','-U','postgres','--template='+pre,raceDb]);
 function connection(statement,hold=false){
  const app='p0_setter_'+process.pid+'_'+raceWorkers.length;
  const child=spawn('psql',[...target(socket,raceDb),'-Atq','-v','VERBOSITY=verbose'],{env:{...postgresEnv,PGAPPNAME:app},stdio:['pipe','pipe','pipe']});
  raceWorkers.push(child);let output='',error='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>error+=x);
  const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>resolve(code));});
  child.stdin.write('begin;'+statement+'\n');if(!hold)child.stdin.end('commit;\n');
  return {app,child,done,output:()=>output,sqlState:()=>error.match(/ERROR:\s+(\w+):/)?.[1]??null};
 }
 async function until(test){const deadline=Date.now()+5000;while(!test()){assert.ok(Date.now()<deadline,'Legacy setter reached the observed catalog lock');await delay(20);}}
 try{
  const holder=connection("lock table private.portal_account_admins in share mode;select 'HELD';",true);
  await until(()=>holder.output().includes('HELD'));
  const writer=connection(actor(9)+`select public.set_portal_account_admin('${id(1)}',true);`);
  await until(()=>sql(socket,raceDb,`select exists(select 1 from pg_stat_activity where application_name='${writer.app}' and wait_event_type='Lock');`).trim()==='t');
  const disabler=connection(actor(5).replace('set local role authenticated;','')+`set statement_timeout='700ms';update public.profiles set account_status='disabled',disabled_at=clock_timestamp() where id='${id(9)}';`);
  const disableCode=await disabler.done;
  holder.child.stdin.end('rollback;\n');assert.equal(await holder.done,0);
  const writerCode=await writer.done;
  const disableState=disabler.sqlState();
  const actorActive=sql(socket,raceDb,`select account_status='active' from public.profiles where id='${id(9)}';`).trim()==='t';
  const grantCount=Number(sql(socket,raceDb,`select count(*) from private.portal_account_admins where auth_user_id='${id(1)}' and revoked_at is null;`).trim());
  const passed=disableCode!==0&&['42501','57014'].includes(disableState)&&writerCode===0&&actorActive&&grantCount===1;
  results.push({label:'legacy_setter_actor_disable_race',passed,disableCode,disableState,writerCode,actorActive,grantCount});
  console.log(`${passed?'PASS':'FAIL'} legacy_setter_actor_disable_race disableCode=${disableCode} writerCode=${writerCode}`);
 }finally{
  for(const child of raceWorkers)if(child.exitCode===null){if(!child.stdin.writableEnded)child.stdin.end('rollback;\n');child.kill('SIGTERM');}
  await Promise.all(raceWorkers.map(child=>child.exitCode===null?new Promise(resolve=>child.once('exit',resolve)):Promise.resolve()));
  command('dropdb',['-h',socket,'-p','55439','-U','postgres',raceDb]);
 }
 writeFileSync(path.join(evidence,'results.json'),JSON.stringify({sha,results},null,2));console.log('EVIDENCE '+evidence);
 assert.equal(results.filter(r=>!r.passed).length,0,'All current System Admin identities protected before Auth/claims');
}finally{
 const pid=Number(readFileSync(socket+'/data/postmaster.pid','utf8').split('\n')[0]);stopCluster(socket);const status=spawnSync('pg_ctl',['-D',socket+'/data','status'],{env:postgresEnv});let alive=false;try{process.kill(pid,0);alive=true;}catch{}
 assert.equal(status.status,3);assert.equal(alive,false);rmSync(socket,{recursive:true,force:true});writeFileSync(path.join(evidence,'cleanup.json'),JSON.stringify({socket,pid,status:status.status,alive,removed:!existsSync(socket)},null,2));
}
