import assert from 'node:assert/strict';
import {readFileSync,rmSync} from 'node:fs';
import {spawn,execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {startCluster,createDatabase,stopCluster,sql,target,postgresEnv} from '../scripts/local-test-postgres.mjs';
const root=new URL('../',import.meta.url);
const read=p=>readFileSync(new URL(p,root),'utf8');
const migration=read('supabase/migrations/20261023041242_employee_lifecycle_mail.sql');
function definition(file,marker){
  const source=read('supabase/migrations/'+file),start=source.indexOf(marker);assert.ok(start>=0,marker);
  const tail=source.slice(start),tag=/\bas\s+(\$[a-zA-Z_]*\$)/i.exec(tail);assert.ok(tag);
  const end=tail.indexOf(tag[1],tag.index+tag[0].length);assert.ok(end>0);
  return tail.slice(0,end+tag[1].length)+';';
}
const socket=startCluster();
const db='mam_test_employee_lifecycle';
const setup=name=>{
  createDatabase(socket,name);
  sql(socket,name,read('tests/employee-lifecycle-mail-bootstrap.sql'));
  sql(socket,name,read('supabase/migrations/20260923010000_durable_notification_delivery_receipts.sql'));
  sql(socket,name,definition('20261020212355_performance_review_meeting_invitation.sql','create or replace function private.notification_event_key_valid('));
  sql(socket,name,definition('20261001130000_confirmed_test_identity_cleanup.sql','create function private.confirmed_test_purge_schema_hash()'));
  sql(socket,name,'revoke all on function private.confirmed_test_purge_schema_hash() from public,anon,authenticated,service_role;insert into private.confirmed_test_purge_schema select true,private.confirmed_test_purge_schema_hash();');
};
const active=new Set();
function session(query,hold=false){
  const c=spawn('psql',[...target(socket,db),'-Atq'],{env:postgresEnv,stdio:['pipe','pipe','pipe']});active.add(c);
  let out='',err='';c.stdout.on('data',v=>out+=v);c.stderr.on('data',v=>err+=v);
  const done=new Promise((resolve,reject)=>{c.on('error',reject);c.on('close',code=>{active.delete(c);code===0?resolve(out):reject(new Error(err));});});done.catch(()=>{});
  c.stdin.write("set statement_timeout='15s';\n"+query+'\n');if(!hold)c.stdin.end();
  return {c,done,output:()=>out};
}
const json=out=>out.split('\n').filter(v=>v.startsWith('{')).map(v=>JSON.parse(v));
try{
  setup(db);sql(socket,db,migration);
  console.log('PASS: migration installs disabled with healthy catalog');
  sql(socket,db,read('tests/employee-lifecycle-mail.sql'));
  console.log('PASS: synthetic lifecycle behavior and ACL assertions');
  const entries=sql(socket,db,`select jsonb_agg(jsonb_build_object('slot',slot,'personId',person_id,'approvedEmail',approved_email,'companyKey',company_key,'teamName',team_name) order by slot) from private.employee_lifecycle_mail_recipients;`).trim();
  const generated=operation=>execFileSync('python3',['-B','-c',`import runpy,json,sys; m=runpy.run_path('scripts/deploy-employee-lifecycle-mail.py'); print(m['${operation}_sql'](m['parse_config'](sys.stdin.read())))`],{input:entries,env:postgresEnv,encoding:'utf8'});
  sql(socket,db,'select public.set_employee_lifecycle_mail_enabled(false);');
  sql(socket,db,generated('configure'));
  assert.equal(json(sql(socket,db,generated('enable')))[0].futureSchedulesSeeded,0);
  console.log('PASS: deployment helper generated configuration/activation SQL executes locally');

  for(const hold of [false,true]){
    const name='mam_test_lifecycle_catalog_'+(hold?'hold':'healthy');setup(name);
    if(hold)sql(socket,name,'grant select on public.profiles to authenticated;');
    const before=sql(socket,name,'select schema_hash from private.confirmed_test_purge_schema;');
    sql(socket,name,migration);
    assert.equal(sql(socket,name,'select schema_hash=private.confirmed_test_purge_schema_hash() from private.confirmed_test_purge_schema;').trim(),hold?'f':'t');
    assert.equal(before===sql(socket,name,'select schema_hash from private.confirmed_test_purge_schema;'),hold);
  }
  const name='mam_test_lifecycle_catalog_reject';setup(name);
  assert.throws(()=>sql(socket,name,migration.replace('do $lifecycle_catalog_after$', 'grant select on public.profiles to authenticated;\ndo $lifecycle_catalog_after$')),/Lifecycle unrelated catalog delta/);
  assert.equal(sql(socket,name,"select to_regclass('private.employee_lifecycle_mail_outbox') is null;").trim(),'t');
  console.log('PASS: healthy/HOLD catalog preservation and unrelated-delta rollback');
  sql(socket,db,"begin;insert into public.internal_org_people(id,full_name,started_date) values('e1000000-0000-4000-8000-000000000001','Concurrent Synthetic',current_date);insert into private.employee_directory_details(person_id,team_name) values('e1000000-0000-4000-8000-000000000001','Management');commit;");
  const h=session("begin;select pg_advisory_xact_lock(hashtextextended('internal_org_people_hierarchy',0));select 'HELD';",true);
  while(!h.output().includes('HELD'))await delay(10);
  const q="set role service_role;select row_to_json(c) from public.claim_employee_lifecycle_mail('e1000000-0000-4000-8000-000000000001',1) c;";
  const a=session(q),b=session(q);
  const deadline=Date.now()+8000;
  while(Number(sql(socket,db,"select count(*) from pg_locks where locktype='advisory' and not granted;").trim())<2){
    assert.ok(Date.now()<deadline,'both claim sessions must queue behind the database lock');await delay(20);
  }
  h.c.stdin.end('commit;\n');await h.done;
  const claims=(await Promise.all([a.done,b.done])).flatMap(json);assert.equal(claims.length,1);
  const c=claims[0];
  const reserve=`set role service_role;select public.reserve_employee_lifecycle_mail('${c.payload.eventKey}','${c.payload.recipient}','','${c.claim_token}');`;
  const race=(await Promise.all([session(reserve).done,session(reserve).done])).flatMap(json);
  assert.equal(race.filter(r=>r.outcome==='send').length,1);assert.equal(race.filter(r=>r.rejectionCode==='delivery-in-flight').length,1);
  console.log('PASS: concurrent claims and reservations grant exactly one send');
}finally{
  for(const c of active){c.stdin.end('rollback;\n');c.kill('SIGTERM');}
  stopCluster(socket);rmSync(socket,{recursive:true});
}
