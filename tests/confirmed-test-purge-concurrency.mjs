import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
export async function testPurgeConcurrency(args, env) {
 const query=(sql)=>{const r=spawnSync('psql',[...args,'-Atq'],{env,input:sql,encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim();};
 const launch=(sql)=>{
  const child=spawn('psql',[...args,'-Atq'],{env}); let stdout='',stderr='';
  child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.stdin.end(sql);
  return new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',status=>resolve({status,stdout,stderr}));});
 };
 query(`insert into auth.users(id,email,email_confirmed_at) values ('95000000-0000-4000-8000-000000000001','race-admin@example.test',now()),('95000000-0000-4000-8000-000000000003','race-real@example.test',now());
 insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after) values ('95000000-0000-4000-8000-000000000001','Race Admin Synthetic','system_admin','race-admin@example.test',now()-interval '1 day');
 insert into public.internal_org_people(id,full_name,company_key,position_title,is_active) values ('95000000-0000-4000-8000-000000000002','Race Fake Synthetic','mam','Synthetic',false);`);
 const actor=`select set_config('request.jwt.claims',jsonb_build_object('sub','95000000-0000-4000-8000-000000000001','role','authenticated','iat',extract(epoch from now())::bigint,'is_anonymous',false)::text,false);`;
 const preview=`public.preview_confirmed_test_identity_purge('95000000-0000-4000-8000-000000000002',null,'mam','Race Fake Synthetic',null,1,null)`;
 const hash=query(`${actor} select ${preview}->>'manifest_hash';`).split('\n').at(-1);
 const writer=launch(`set application_name='purge-auth-race'; begin; update auth.users set raw_user_meta_data=jsonb_build_object('shared_person','95000000-0000-4000-8000-000000000002') where id='95000000-0000-4000-8000-000000000003'; select pg_sleep(1); commit;`);
 for(let n=0;n<100;n++) {
  if(query("select count(*) from pg_stat_activity where application_name='purge-auth-race' and wait_event='PgSleep'")==='1') break;
  if(n===99) throw new Error('Auth writer never acquired its row');
  await new Promise(r=>setTimeout(r,10));
 }
 const result=await launch(`${actor} set role authenticated; select public.prepare_confirmed_test_identity_purge('95000000-0000-4000-8000-000000000002',null,'mam','Race Fake Synthetic',null,1,null,'${hash}',true,true);`);
 await writer;
 assert.notEqual(result.status,0,'Purge accepted concurrent shared Auth metadata');
 assert.match(result.stderr,/shared metadata reference in auth.users|could not obtain lock/);
 assert.equal(query("select count(*) from public.internal_org_people where id='95000000-0000-4000-8000-000000000002'"),'1');
 assert.equal(query("select count(*) from private.confirmed_test_identity_purges where person_id='95000000-0000-4000-8000-000000000002'"),'0');
 console.log('PASS: concurrent Auth actor/metadata write excludes purge; target and receipt unchanged');
 query("update auth.users set raw_user_meta_data='{}' where id='95000000-0000-4000-8000-000000000003'");
 for (const unauthorized of [true,false]) {
  const blocker=launch(`set application_name='purge-reverse-writer'; begin; lock table private.annual_leave_balance_history in row exclusive mode; select pg_sleep(0.8); update auth.users set raw_user_meta_data='{}' where id='95000000-0000-4000-8000-000000000003'; commit;`);
  for(let n=0;n<100;n++) {if(query("select count(*) from pg_stat_activity where application_name='purge-reverse-writer' and wait_event='PgSleep'")==='1')break;await new Promise(r=>setTimeout(r,10));}
  const claims=unauthorized?actor.replaceAll('95000000-0000-4000-8000-000000000001','95000000-0000-4000-8000-000000000003'):actor;
  const started=Date.now();
  const purge=await launch(`${claims} set role authenticated; select public.prepare_confirmed_test_identity_purge('95000000-0000-4000-8000-000000000002',null,'mam','Race Fake Synthetic',null,1,null,'${hash}',true,true);`);
  const elapsed=Date.now()-started;
  const normal=await blocker;
  assert.equal(normal.status,0,normal.stderr);
  assert.notEqual(purge.status,0);
  assert.match(purge.stderr,unauthorized?/Active System Admin required/:/could not obtain lock/);
  assert.ok(elapsed<500,`Purge blocked ordinary writer for ${elapsed}ms`);
 }
 console.log('PASS: unauthorized RPC never locks; reverse-order ordinary writer survives fail-fast purge');
}
