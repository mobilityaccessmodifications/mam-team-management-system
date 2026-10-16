import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,existsSync,realpathSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
const root=process.cwd();
const scratch=realpathSync(os.tmpdir());
export const evidence=process.env.MAM_PERFORMANCE_TEST_EVIDENCE??mkdtempSync(path.join(scratch,'pre-'));
mkdirSync(evidence,{recursive:true,mode:0o700});
export const migration='supabase/migrations/20261016150000_performance_reviews_and_mail.sql';
export const env={PATH:process.env.PATH,TMPDIR:scratch,LANG:'C',LC_ALL:'C',PGPASSFILE:'/dev/null',PGSERVICEFILE:'/dev/null',PGCONNECT_TIMEOUT:'5'};
let ordinal=0;
export function definition(file,marker){
 const source=readFileSync(path.join(root,'supabase/migrations',file),'utf8');
 const start=source.indexOf(marker);assert.ok(start>=0,marker);
 const tail=source.slice(start),tag=/\bas\s+(\$[a-zA-Z_]*\$)/i.exec(tail);assert.ok(tag);
 const end=tail.indexOf(tag[1],tag.index+tag[0].length);assert.ok(end>0);
 return tail.slice(0,end+tag[1].length)+';';
}
export function ownedCluster(major=17){
 assert.ok([16,17].includes(major));
 const socket=realpathSync(mkdtempSync(path.join(scratch,'pr'))),data=path.join(socket,'d'),port=55437;
 mkdirSync(evidence,{recursive:true});
 const marker={owner:'performance-production-SQL_ONLY-20261016',socket,data,port,major,listenAddresses:'',tcp:false};
 writeFileSync(path.join(socket,'owner.json'),JSON.stringify(marker,null,2));
 const command=(name,args,input)=>{const r=spawnSync(name,args,{env,input,encoding:'utf8',timeout:90000,maxBuffer:32*1024*1024});assert.equal(r.status,0,`${name}: ${r.error?.message??r.stderr}`);return r.stdout;};
 command('initdb',['-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8']);
 command('pg_ctl',['-D',data,'-l',path.join(socket,'postgres.log'),'-o',`-k ${socket} -p ${port} -c listen_addresses='' -c unix_socket_permissions=0700 -c autovacuum=off`,'-w','start']);
 const run=(db,sql)=>{
  const label=`native-${path.basename(socket)}-${String(++ordinal).padStart(4,'0')}`;
  writeFileSync(path.join(evidence,label+'.sql'),sql);
  const r=spawnSync('psql',['-X','-h',socket,'-p',String(port),'-U','postgres','-d',db,'-At','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-f','-'],{env,input:sql,encoding:'utf8',timeout:90000,maxBuffer:32*1024*1024});
  writeFileSync(path.join(evidence,label+'.stdout.log'),r.stdout??'');writeFileSync(path.join(evidence,label+'.stderr.log'),r.stderr??'');
  writeFileSync(path.join(evidence,label+'.receipt.json'),JSON.stringify({classification:'SQL_ONLY',database:db,exit:r.status,signal:r.signal,error:r.error?.message??null},null,2));
  return r;
 };
 const sql=(db,s)=>{const r=run(db,s);assert.equal(r.status,0,r.stderr);return r.stdout;};
 const identity=sql('postgres',"select jsonb_build_object('version',current_setting('server_version'),'major',current_setting('server_version_num')::integer/10000,'listenAddresses',current_setting('listen_addresses'),'database',current_database());");
 assert.equal(JSON.parse(identity.trim()).major,major);assert.equal(JSON.parse(identity.trim()).listenAddresses,'');
 writeFileSync(path.join(evidence,`cluster-${path.basename(socket)}.json`),JSON.stringify({...marker,identity},null,2));
 return {socket,port,run,sql,setup(db,apply=true){
  assert.match(db,/^mam_test_pr_[a-z0-9_]+$/);
  command('createdb',['-h',socket,'-p',String(port),'-U','postgres','--template=template0',db]);
  sql(db,readFileSync('tests/performance-review-production-fixture.sql','utf8'));
  for(const [f,m] of [
   ['20260813051743_portal_account_management.sql','create function private.is_active_portal_account('],
   ['20261008110000_subscription_employee_delegation.sql','CREATE OR REPLACE FUNCTION private.portal_role_policy('],
   ['20261006104000_unified_portal_roles.sql','create function private.lock_portal_role_actor()'],
   ['20261006104000_unified_portal_roles.sql','CREATE OR REPLACE FUNCTION private.resolve_internal_org_employee_manager('],
   ['20261001130000_confirmed_test_identity_cleanup.sql','create function private.confirmed_test_has_reference('],
   ['20261001140000_confirmed_test_purge_delivered_leave_history.sql','create or replace function private.reject_retired_test_identity_reference()'],
   ['20261001130000_confirmed_test_identity_cleanup.sql','create function private.confirmed_test_purge_schema_hash()']]) sql(db,definition(f,m));
  sql(db,'revoke all on function private.portal_role_policy(uuid),private.lock_portal_role_actor(),private.reject_retired_test_identity_reference(),private.confirmed_test_has_reference(jsonb,uuid[]),private.confirmed_test_purge_schema_hash() from public,anon,authenticated,service_role; revoke all on function private.resolve_internal_org_employee_manager(uuid) from public,anon,authenticated;');
  sql(db,"create table private.confirmed_test_purge_schema(singleton boolean primary key default true check(singleton),schema_hash text not null); alter table private.confirmed_test_purge_schema enable row level security; alter table private.confirmed_test_purge_schema force row level security; revoke all on private.confirmed_test_purge_schema from public,anon,authenticated,service_role; insert into private.confirmed_test_purge_schema select true,private.confirmed_test_purge_schema_hash();");
  if(apply&&existsSync(migration)) sql(db,readFileSync(migration,'utf8'));
 },stop(){
  assert.deepEqual(JSON.parse(readFileSync(path.join(socket,'owner.json'),'utf8')),marker);
  command('pg_ctl',['-D',data,'-m','fast','-w','stop']);
  const r=spawnSync('pg_ctl',['-D',data,'status'],{env,encoding:'utf8'});
  const cleanup={...marker,statusExit:r.status,stopped:r.status===3,pidAbsent:!existsSync(path.join(data,'postmaster.pid')),socketAbsent:!existsSync(path.join(socket,`.s.PGSQL.${port}`))};
  writeFileSync(path.join(evidence,`cleanup-${path.basename(socket)}.json`),JSON.stringify(cleanup,null,2));
  writeFileSync(path.join(evidence,`cluster-${path.basename(socket)}.postgres.log`),readFileSync(path.join(socket,'postgres.log')));
  assert.ok(cleanup.stopped&&cleanup.pidAbsent&&cleanup.socketAbsent);
 }};
}
export const q=x=>x===null?'null':"'"+String(x).replaceAll("'","''")+"'";
export const user=i=>`a1000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
export const person=i=>`b1000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
export const actor=(i,s)=>`begin;set local role authenticated;select set_config('request.jwt.claims',${q(JSON.stringify({sub:user(i),iat:1900000000}))},true);${s}\ncommit;`;
export function rows(output){return output.trim().split('\n').filter(s=>s.startsWith('{')||s.startsWith('[')).map(s=>JSON.parse(s));}
