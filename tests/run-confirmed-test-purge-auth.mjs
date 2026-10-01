#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes, createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { createClient } from '@supabase/supabase-js';

const host='unix:///Users/nixon/.colima/mam-cleanup-e2e/docker.sock';
const config='/Users/nixon/.hermes/profiles/mam/cache/scratch/docker-mam-cleanup';
const images={db:'postgres:17.6@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929',auth:'supabase/gotrue:v2.189.0@sha256:385184459f57569c54c25209f51f3b2be99ddd7c4ce9e3555b5d3eea8447b7cf',rest:'postgrest/postgrest:v14.12@sha256:54000f24847d01a2c2302e0041cf0618b875c57fb48507d743cfa9aaa50bf43c'};
const label='mam.confirmed-test-purge-auth';
const prefix=`mam-purge-auth-${randomBytes(5).toString('hex')}`;
const names={db:prefix+'-db',auth:prefix+'-auth',rest:prefix+'-rest'};
const secret=randomBytes(48).toString('hex'), password=randomBytes(24).toString('hex');
const env={PATH:process.env.PATH,HOME:config,DOCKER_HOST:host,DOCKER_CONFIG:config};
function docker(args,input,allowFailure=false) {
  const r=spawnSync('env',[`DOCKER_HOST=${host}`,`DOCKER_CONFIG=${config}`,'docker',...args],{env,input,encoding:'utf8',maxBuffer:16*1024*1024});
  if(!allowFailure && (r.error||r.status!==0)) throw new Error(`Isolated Docker ${args[0]} failed: ${String(r.stderr).replaceAll(password,'[synthetic]').replaceAll(secret,'[synthetic]')}`);
  return args[0]==='logs' ? `${r.stdout??''}\n${r.stderr??''}` : r.stdout?.trim();
}
function sql(query){return docker(['exec','-i',names.db,'psql','-X','-U','postgres','-d','mam_test_auth_purge','-v','ON_ERROR_STOP=1','-Atq'],query);}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function ready(check,name){for(let n=0;n<100;n++){try{if(await check())return;}catch{}await delay(300);}throw new Error(`${name} readiness failed (no service logs printed)`);}
function jwt(role){const head=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');const body=Buffer.from(JSON.stringify({role,aud:'authenticated',iss:'synthetic-local',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600})).toString('base64url');return `${head}.${body}.${createHmac('sha256',secret).update(`${head}.${body}`).digest('base64url')}`;}
const serviceKey=jwt('service_role'), anonKey=jwt('anon');
let gateway;
const requests=[];
const faults={deleteResponse:null,readback:false,afterDelete:false};
try {
  assert.equal(docker(['info','--format','{{.ServerVersion}}']),'29.5.2');
  docker(['network','create','--label',label,prefix]);
  docker(['volume','create','--label',label,prefix+'-data']);
  for(const image of Object.values(images)) {docker(['pull',image]);console.log(`IMAGE ${image} ID ${docker(['image','inspect',image,'--format','{{.Id}}'])}`);}
  docker(['run','-d','--name',names.db,'--label',label,'--network',prefix,'--network-alias','db','--mount',`type=volume,src=${prefix}-data,dst=/var/lib/postgresql/data`,'-e',`POSTGRES_PASSWORD=${password}`,'-e','POSTGRES_DB=mam_test_auth_purge',images.db]);
  await ready(()=>docker(['exec',names.db,'psql','-X','-U','postgres','-d','mam_test_auth_purge','-Atqc','select 1'],undefined,true)==='1','PostgreSQL');
  sql(`create role supabase_auth_admin login noinherit password '${password}'; create schema auth authorization supabase_auth_admin; alter role supabase_auth_admin set search_path=auth;`);
  docker(['run','-d','--name',names.auth,'--label',label,'--network',prefix,'-p','127.0.0.1::9999','-e','GOTRUE_API_HOST=0.0.0.0','-e','GOTRUE_API_PORT=9999','-e','API_EXTERNAL_URL=http://127.0.0.1:9999','-e','GOTRUE_SITE_URL=http://127.0.0.1','-e','GOTRUE_DB_DRIVER=postgres','-e',`GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:${password}@db:5432/mam_test_auth_purge`,'-e','GOTRUE_DB_NAMESPACE=auth','-e',`GOTRUE_JWT_SECRET=${secret}`,'-e','GOTRUE_JWT_ADMIN_ROLES=service_role','-e','GOTRUE_JWT_AUD=authenticated','-e','GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated','-e','GOTRUE_EXTERNAL_EMAIL_ENABLED=true','-e','GOTRUE_MAILER_AUTOCONFIRM=true','-e','GOTRUE_DISABLE_SIGNUP=true','-e','LOG_LEVEL=error',images.auth]);
  const authPort=JSON.parse(docker(['inspect',names.auth,'--format','{{json .NetworkSettings.Ports}}']))['9999/tcp'][0].HostPort;
  const authUrl=`http://127.0.0.1:${authPort}`;
  await ready(async()=> (await fetch(authUrl+'/health')).ok,'GoTrue');
  assert.ok(Number(sql('select count(*) from auth.schema_migrations;'))>0);
  const platform=readFileSync('tests/migrations/0001-supabase-platform.sql','utf8').replace('create schema auth;','').replace(/create table auth\.users \([\s\S]*?\n\);/,'').replace(/create function auth\.(uid|jwt|role)\(\)[\s\S]*?\n\$\$;/g,'');
  sql(platform);
  sql(`create role authenticator login noinherit password '${password}'; grant anon,authenticated,service_role to authenticator;`);
  const migrations=readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort();
  for(const f of migrations) {try{sql(readFileSync('supabase/migrations/'+f,'utf8'));}catch(e){throw new Error(`${f}: ${e.message}`);}}
  console.log(`PASS full unchanged application replay (${migrations.length} migrations); GoTrue owns real auth schema`);
  assert.equal(docker(['inspect',names.db,'--format','{{json .HostConfig.PortBindings}}']),'{}');
  sql(readFileSync('tests/migrations/effective-contract.sql','utf8').replace("  assert current_setting('listen_addresses') = '', 'Replay must not listen on TCP';",''));
  console.log('PASS effective schema/RLS/ACL contract (private Docker TCP, no database host port; UNIX-only infrastructure assertion replaced)');
  docker(['run','-d','--name',names.rest,'--label',label,'--network',prefix,'-p','127.0.0.1::3000','-e',`PGRST_DB_URI=postgres://authenticator:${password}@db:5432/mam_test_auth_purge`,'-e','PGRST_DB_SCHEMAS=public','-e','PGRST_DB_ANON_ROLE=anon','-e',`PGRST_JWT_SECRET=${secret}`,images.rest]);
  const restPort=JSON.parse(docker(['inspect',names.rest,'--format','{{json .NetworkSettings.Ports}}']))['3000/tcp'][0].HostPort;
  const restUrl=`http://127.0.0.1:${restPort}`;
  await ready(async()=> (await fetch(restUrl+'/')).ok,'PostgREST');
  gateway=createServer(async(req,res)=>{
    try {
      const auth=req.url.startsWith('/auth/v1');
      const route=req.url.replace(auth?'/auth/v1':'/rest/v1','');
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const body=Buffer.concat(chunks);
      if(route.startsWith('/admin/users/')) requests.push({method:req.method,route,soft:req.method==='DELETE'?JSON.parse(body.toString()).should_soft_delete:undefined});
      if(auth && req.method==='GET' && route.startsWith('/admin/users/') && faults.afterDelete && faults.readback){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({code:'unexpected_failure',msg:'synthetic transport outage'}));return;}
      const upstream=await fetch((auth?authUrl:restUrl)+route,{method:req.method,headers:{authorization:req.headers.authorization??'',apikey:req.headers.apikey??'','content-type':req.headers['content-type']??'application/json'},body:['GET','HEAD'].includes(req.method)?undefined:body});
      const text=await upstream.text();
      if(auth && req.method==='DELETE' && route.startsWith('/admin/users/')){
        assert.equal(upstream.status,200,'real provider deletion failed');faults.afterDelete=true;
        if(faults.deleteResponse==='lost'){res.destroy();return;}
        if(faults.deleteResponse==='partial'){res.writeHead(200,{'content-type':'application/json'});res.end('{');return;}
      }
      res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json'});res.end(text);
    }catch{res.writeHead(502,{'content-type':'application/json'});res.end('{"code":"synthetic_gateway_failure"}');}
  });
  await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${gateway.address().port}`;
  const opts={auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}};
  const admin=createClient(base,serviceKey,opts);
  const session=createClient(base,anonKey,opts);
  const compiled=await build({entryPoints:['src/lib/confirmed-test-identity-purge.ts'],bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'server-only-test',setup(b){b.onResolve({filter:/^server-only$/},()=>({path:'server-only',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:''}));}}]});
  const run=(await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)).runConfirmedTestIdentityPurge;
  function ok(result){assert.equal(result.error,null,result.error?.code??'provider error');return result.data;}
  async function account(name){const email=`${name}@example.test`;const user=ok(await admin.auth.admin.createUser({email,password,email_confirm:true})).user;assert.ok(user.id);return {id:user.id,email};}
  const actor=await account('purge-admin'), canonical=await account('canonical'), other=await account('other-confirmed-homonym');
  ok(await admin.auth.admin.updateUserById(canonical.id,{user_metadata:{full_name:'Shared Synthetic Person'}}));
  function profile(a,role='employee',disabled=false,fullName=a.email){sql(`insert into public.profiles(id,full_name,app_role,login_name,account_status,credentials_valid_after,disabled_at) values ('${a.id}','${fullName}','${role}','${a.email}','${disabled?'disabled':'active'}',now()-interval '1 day',${disabled?'now()':'null'}); insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id,is_active) values ('${a.id}','${fullName}','mam','Synthetic role','${a.id}',true);`);}
  profile(actor,'system_admin');profile(canonical,'employee',false,'Shared Synthetic Person');profile(other);
  sql(`insert into private.portal_account_admins(auth_user_id) values ('${actor.id}');`);
  ok(await session.auth.signInWithPassword({email:actor.email,password}));
  assert.equal(ok(await session.rpc('can_change_employee_view')),true);
  const snapshots=sql(`select jsonb_agg(to_jsonb(t) order by id) from public.profiles t where id in ('${actor.id}','${canonical.id}','${other.id}'); select jsonb_agg(to_jsonb(t) order by id) from public.internal_org_people t where id in ('${actor.id}','${canonical.id}','${other.id}');`);
  const authSnapshots=new Map();for(const a of [actor,canonical,other])authSnapshots.set(a.id,ok(await admin.auth.admin.getUserById(a.id)).user);
  async function target(name,fullName=`${name}@example.test`){const a=await account(name);profile(a,'employee',true,fullName);const client=createClient(base,anonKey,opts);ok(await client.auth.signInWithPassword({email:a.email,password}));assert.equal(sql(`select count(*) from auth.sessions where user_id='${a.id}';`),'1');ok(await admin.auth.admin.updateUserById(a.id,{ban_duration:'876000h'}));const row=JSON.parse(sql(`select jsonb_build_object('personVersion',version,'accountVersion',(select account_version from public.profiles where id='${a.id}')) from public.internal_org_people where id='${a.id}';`));return {mode:'preview',personId:a.id,authUserId:a.id,companyKey:'mam',fullName,loginName:a.email,...row};}
  function apply(input,preview){return {...input,mode:'apply',manifestHash:preview.manifest_hash,confirmTestOnly:true,destroyExclusiveHistory:true};}
  async function absent(input){const read=await admin.auth.admin.getUserById(input.authUserId);assert.equal(read.data.user,null);assert.equal(read.error.code,'user_not_found');assert.equal(read.error.status,404);assert.equal(sql(`select count(*) from auth.users where id='${input.authUserId}'; select count(*) from public.profiles where id='${input.authUserId}'; select count(*) from public.internal_org_people where id='${input.personId}'; select count(*) from auth.identities where user_id='${input.authUserId}'; select count(*) from auth.sessions where user_id='${input.authUserId}';`),'0\n0\n0\n0\n0');}
  const normal=await target('confirmed-normal');
  sql(`begin;
    insert into public.leave_requests(id,user_id,employee_person_id,leave_type,request_type_label,start_date,end_date,status,submitted_at,business_days)
      select gen_random_uuid(),'${normal.authUserId}','${normal.personId}','unpaid','Unpaid leave',date '2026-11-01'+n,date '2026-11-01'+n,'cancelled',now(),1 from generate_series(1,2) n;
    insert into private.leave_notification_outbox(request_id,event,payload)
      select request_id,'leave-submitted',payload||jsonb_build_object('event','leave-submitted') from private.leave_notification_outbox where request_id in(select id from public.leave_requests where employee_person_id='${normal.personId}');
    update private.leave_notification_outbox set attempts=1,delivery_payload=payload||jsonb_build_object('managerEmail','reviewer@example.test','employeeEmail','applicant@example.test','employeeEmails',jsonb_build_array('applicant@example.test'))
      where request_id in(select id from public.leave_requests where employee_person_id='${normal.personId}');
    insert into private.leave_submission_receipts(actor_user_id,submission_key,input_hash,result)
      select '${normal.authUserId}',gen_random_uuid(),repeat('a',64),jsonb_build_object('approval_required',true,'assigned_reviewer_label','Synthetic reviewer','id',id,'status','Pending') from public.leave_requests where employee_person_id='${normal.personId}';
    insert into private.notification_delivery_receipts(event_key,state,delivery_token,recipient,cc,provider_receipt,sent_at)
      select 'leave:'||o.request_id::text||':'||o.event||':'||left(encode(extensions.digest(o.id::text||case when o.event='leave-submitted' then ':'||audience else '' end,'sha256'),'hex'),24),
      'sent',gen_random_uuid(),case when audience='employee' then 'applicant@example.test' when audience='reviewers' then 'hr@mobilityaccess.com.au,reviewer@example.test' else 'reviewer@example.test' end,
      case when audience<>'shared' then '' when o.delivery_payload->'wasApproved'='false'::jsonb then 'hr@mobilityaccess.com.au' else 'accounts@mobilityaccess.com.au,hr@mobilityaccess.com.au' end,jsonb_build_object('accepted',true,'messageId','synthetic-message','requestId','synthetic-provider-request','statusCode',202),clock_timestamp()
      from private.leave_notification_outbox o cross join lateral unnest(case when o.event='leave-submitted' then array['reviewers','employee'] else array['shared'] end) audience
      where o.request_id in(select id from public.leave_requests where employee_person_id='${normal.personId}');
    update private.leave_notification_outbox set delivered_at=clock_timestamp() where request_id in(select id from public.leave_requests where employee_person_id='${normal.personId}');
    insert into private.portal_account_status_change_claims(auth_user_id,person_id,claimed_by,requested_enabled,status,claimed_account_status,claimed_account_version,final_account_version,finalised_at,provider_status,executor_token,provider_started_at,provider_finished_at)
      values('${normal.authUserId}','${normal.personId}','${actor.id}',false,'finalised','disabled',${normal.accountVersion},${normal.accountVersion},clock_timestamp(),'succeeded',gen_random_uuid(),clock_timestamp(),clock_timestamp());
    insert into private.employee_check_in_reminders(id,person_id,milestone,reminder_sequence,due_date,notify_date,delivery_status) values ('${randomUUID()}','${normal.personId}','2_week','initial','2026-02-01','2026-01-25','completed'),('${randomUUID()}','${other.id}','2_week','initial','2026-02-01','2026-01-25','completed');
    insert into private.employee_directory_audit_events(person_id,actor_user_id,event_type,changed_fields) values ('${normal.personId}','${actor.id}','updated',array['first_name']);
    commit;`);
  const deliverySnapshot=sql('select jsonb_agg(to_jsonb(r) order by event_key) from private.notification_delivery_receipts r;');
  const otherReminderSnapshot=sql(`select jsonb_agg(to_jsonb(t) order by id) from private.employee_check_in_reminders t where person_id='${other.id}';`);
  const targetClient=createClient(base,anonKey,opts);
  const banned=await targetClient.auth.signInWithPassword({email:normal.loginName,password});assert.equal(banned.error.code,'user_banned');
  const preview=await run(session,admin,normal);
  assert.equal((await run(session,admin,apply(normal,preview))).phase,'complete');await absent(normal);
  assert.deepEqual(requests.filter(r=>r.route.endsWith(normal.authUserId)&&r.method==='DELETE').map(r=>r.soft),[false]);
  console.log('PASS real banned/disabled linked purge: deleteUser(id,false), exact 404 user_not_found, operational/Auth/identity/session absence');
  assert.equal(sql(`select count(*) from public.leave_requests where employee_person_id='${normal.personId}'; select count(*) from private.employee_check_in_reminders where person_id='${normal.personId}'; select jsonb_array_length(retained_audit->'private.employee_directory_audit_events') from private.confirmed_test_identity_purges where person_id='${normal.personId}';`),'0\n0\n1');
  for(const dataset of ['employees','leave_requests','leave_events','check_ins','check_in_events']){const data=ok(await admin.rpc('analytics_dashboard_dataset',{p_dataset:dataset,p_from_date:null,p_to_date:null,p_limit:1000,p_offset:0}));assert.equal(JSON.stringify(data).includes(normal.personId),false);assert.equal(JSON.stringify(data).includes(normal.fullName),false);}
  assert.equal(otherReminderSnapshot,sql(`select jsonb_agg(to_jsonb(t) order by id) from private.employee_check_in_reminders t where person_id='${other.id}';`));
  assert.equal(sql(`select count(*) from private.leave_notification_outbox; select count(*) from private.leave_submission_receipts where actor_user_id='${normal.authUserId}'; select count(*) from private.portal_account_status_change_claims where auth_user_id='${normal.authUserId}'; select jsonb_array_length(retained_audit->'private.leave_notification_outbox'),jsonb_array_length(retained_audit->'private.leave_submission_receipts'),jsonb_array_length(retained_audit->'private.portal_account_status_change_claims'),jsonb_array_length(retained_audit->'private.notification_delivery_receipts') from private.confirmed_test_identity_purges where person_id='${normal.personId}';`),'0\n0\n0\n4|2|1|6');
  assert.equal(sql(`select bool_and(d#>>'{result,status}'='Pending' and not (d->'result' ? 'assigned_reviewer_label')) from private.confirmed_test_identity_purges p cross join lateral jsonb_array_elements(p.retained_audit->'private.leave_submission_receipts') d where p.person_id='${normal.personId}';`),'t');
  assert.equal(sql('select jsonb_agg(to_jsonb(r) order by event_key) from private.notification_delivery_receipts r;'),deliverySnapshot);
  console.log('PASS actual data/RPC phase: 2 cancelled leaves/4 delivered outbox/2 submission receipts/1 finalized claim destroyed, 6 no-resend receipts unchanged, provenance retained, dashboard absence, other history unchanged');
  const directory={mode:'preview',personId:randomUUID(),authUserId:null,companyKey:'mam',fullName:'Directory Only Synthetic',loginName:null,personVersion:1,accountVersion:null};
  sql(`insert into public.internal_org_people(id,full_name,company_key,position_title,is_active) values ('${directory.personId}','${directory.fullName}','mam','Synthetic role',false);`);
  const dp=await run(session,null,directory);const before=requests.length;assert.equal((await run(session,null,apply(directory,dp))).phase,'complete');assert.equal(requests.length,before);assert.equal(sql(`select count(*) from public.internal_org_people where id='${directory.personId}';`),'0');
  console.log('PASS directory-only inactive purge with null admin: no Auth Admin HTTP call');
  for(const fault of ['partial','lost']){
    const input=await target(`confirmed-${fault}`);const p=await run(session,admin,input);
    faults.deleteResponse=fault;faults.readback=true;faults.afterDelete=false;
    assert.equal((await run(session,admin,apply(input,p))).phase,'reconciliation_required');
    assert.equal(sql(`select phase from private.confirmed_test_identity_purges where person_id='${input.personId}';`),'auth_delete_started');
    faults.readback=false;faults.deleteResponse=null;faults.afterDelete=false;
    assert.equal((await run(session,admin,{mode:'reconcile',personId:input.personId,authUserId:input.authUserId})).phase,'complete');await absent(input);
    assert.equal(requests.filter(r=>r.method==='DELETE'&&r.route.endsWith(input.authUserId)).length,1);
    console.log(`PASS ${fault} response after actual GoTrue deletion + unavailable readback: durable reconciliation, no second DELETE`);
  }
  const blocked=await target('confirmed-blocked');
  ok(await admin.auth.admin.updateUserById(other.id,{user_metadata:{linked_test_uuid:blocked.authUserId}}));
  await assert.rejects(run(session,admin,blocked),/shared metadata reference in auth.users/);
  assert.equal(requests.filter(r=>r.method==='DELETE'&&r.route.endsWith(blocked.authUserId)).length,0);
  assert.equal(ok(await admin.auth.admin.getUserById(blocked.authUserId)).user.id,blocked.authUserId);
  assert.equal(sql(`select count(*) from public.profiles where id='${blocked.authUserId}'; select count(*) from public.internal_org_people where id='${blocked.personId}';`),'1\n1');
  ok(await admin.auth.admin.updateUserById(other.id,{user_metadata:{linked_test_uuid:null}}));
  console.log('PASS no-Storage-service shared-reference blocker through real Auth Admin metadata: target remains intact');
  const identityArgs=i=>({p_person_id:i.personId,p_auth_user_id:i.authUserId,p_company_key:i.companyKey,p_full_name:i.fullName,p_login_name:i.loginName,p_person_version:i.personVersion,p_account_version:i.accountVersion});
  const unbanned=await target('confirmed-unbanned');
  const up=await run(session,admin,unbanned);
  ok(await admin.auth.admin.updateUserById(unbanned.authUserId,{ban_duration:'none'}));
  const rejected=await session.rpc('prepare_confirmed_test_identity_purge',{...identityArgs(unbanned),p_manifest_hash:up.manifest_hash,p_confirm_test_only:true,p_destroy_exclusive_history:true});
  assert.ok(rejected.error,'Unbanned direct RPC must reject before business destruction');
  assert.equal(sql(`select count(*) from public.profiles where id='${unbanned.authUserId}'; select count(*) from public.internal_org_people where id='${unbanned.personId}'; select count(*) from private.confirmed_test_identity_purges where person_id='${unbanned.personId}';`),'1\n1\n0');
  console.log('PASS real unban after review: direct prepare RPC rejects and target business records remain intact');
  const homonym=await target('confirmed-homonym','Shared Synthetic Person');const hp=await run(session,admin,homonym);
  assert.equal((await run(session,admin,apply(homonym,hp))).phase,'complete');await absent(homonym);
  ok(await admin.auth.admin.updateUserById(canonical.id,{ban_duration:'none'}));
  assert.equal(ok(await admin.auth.admin.getUserById(canonical.id)).user.id,canonical.id);
  console.log('PASS real homonym preserved and still Auth-updateable after exact other identity purge');
  const containment=await target('confirmed-containment');const cp=await run(session,admin,containment);
  ok(await session.rpc('prepare_confirmed_test_identity_purge',{...identityArgs(containment),p_manifest_hash:cp.manifest_hash,p_confirm_test_only:true,p_destroy_exclusive_history:true}));
  assert.equal(sql(`select phase from private.confirmed_test_identity_purges where person_id='${containment.personId}';`),'business_purged');
  const rebanned=await admin.auth.admin.updateUserById(containment.authUserId,{ban_duration:'876001h'});
  if(rebanned.error){
    const logs=docker(['logs',names.db],undefined,true);
    const fields=[...new Set([...String(logs).matchAll(/"([a-z_]+)"\s*=/g)].map(m=>m[1]))];
    console.log(`CONTAINMENT FAILED provider HTTP ${rebanned.error.status}; retired-reference rejection ${String(logs).includes('Retired confirmed-test identity reference is prohibited')}; SQL UPDATE field names ${fields.join(',')}`);
    console.log('CONTAINMENT generated fields '+sql("select coalesce(jsonb_agg(attname),'[]'::jsonb) from pg_attribute where attrelid='auth.users'::regclass and attgenerated<>'';"));
  }
  ok(rebanned);
  assert.ok(Date.parse(ok(await admin.auth.admin.getUserById(containment.authUserId)).user.banned_until)>Date.now());
  assert.equal((await run(session,admin,apply(containment,cp))).phase,'complete');await absent(containment);
  console.log('PASS real containment reban after business prepare and before supported hard delete');
  assert.equal(snapshots,sql(`select jsonb_agg(to_jsonb(t) order by id) from public.profiles t where id in ('${actor.id}','${canonical.id}','${other.id}'); select jsonb_agg(to_jsonb(t) order by id) from public.internal_org_people t where id in ('${actor.id}','${canonical.id}','${other.id}');`));
  for(const a of [actor,canonical,other]){const user=ok(await admin.auth.admin.getUserById(a.id)).user;const old=authSnapshots.get(a.id);for(const key of ['id','email','created_at','app_metadata','user_metadata','identities'])assert.deepEqual(user[key],old[key]);}
  assert.equal(Number(sql('select count(*) from auth.users;')),5);
  assert.equal(Number(sql("select count(*) from private.confirmed_test_identity_purges where phase='complete';")),6);
  assert.equal(sql('select private.confirmed_test_purge_schema_hash()=(select schema_hash from private.confirmed_test_purge_schema);'),'t');
  console.log('PASS actor/canonical/other Auth identities and complete profile/person snapshots preserved; schema/restrictive triggers unchanged');
  console.log('RESULT 10 behavioral integration checks passed; Storage HTTP/object deletion, hosted provider/version and production configuration NOT verified');
} finally {
  if(gateway){gateway.closeAllConnections();await new Promise(r=>gateway.close(r));}
  const mounts=docker(['inspect',names.db,'--format','{{json .Mounts}}'],undefined,true);
  const volumes=mounts?JSON.parse(mounts).filter(m=>m.Type==='volume').map(m=>m.Name):[];
  for(const name of Object.values(names))docker(['rm','-f','-v',name],undefined,true);
  docker(['network','rm',prefix],undefined,true);
  docker(['volume','rm',prefix+'-data'],undefined,true);
  assert.equal(docker(['volume','ls','-q','--filter',`label=${label}`]),'');
  assert.equal(docker(['ps','-aq','--filter',`label=${label}`]),'');
  assert.equal(docker(['network','ls','-q','--filter',`label=${label}`]),'');
  for(const volume of volumes)assert.equal(docker(['volume','ls','-q','--filter',`name=^${volume}$`]),'');
  console.log('CLEANUP verified: no task containers/networks/volumes; dedicated VM left running for parent');
}
