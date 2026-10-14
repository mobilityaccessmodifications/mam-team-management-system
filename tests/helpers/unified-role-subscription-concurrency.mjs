import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { postgresEnv, sql, target } from '../../scripts/local-test-postgres.mjs';

export async function runSubscriptionAuthorityConcurrency(socket, database) {
  const user = 'a1000000-0000-4000-8000-000000000021';
  const p0 = 'a1000000-0000-4000-8000-000000000009';
  const sessions = new Set();
  let counter = 0, passed = 0;
  const failures = [];
  const claims = (actor) => `do $claims$ begin perform set_config('request.jwt.claim.sub','${actor ?? ''}',true);
    perform set_config('request.jwt.claims',${actor ? `jsonb_build_object('sub','${actor}',
      'iat',extract(epoch from clock_timestamp())::bigint,'is_anonymous',false)::text` : `'{}'`},true); end $claims$;`;
  function connection(actor, statement, hold = false, owner = false) {
    const app = `unified_subscription_${process.pid}_${++counter}`;
    const child = spawn('psql', [...target(socket,database),'-v','VERBOSITY=verbose','-Atq'], {
      env: {...postgresEnv,PGAPPNAME:app}, stdio:['pipe','pipe','pipe'],
    });
    sessions.add(child);
    let output = '', error = '', finished = false;
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    const done = new Promise((resolve,reject) => {
      child.on('error',reject);
      child.on('exit',code => { finished=true; sessions.delete(child); resolve({code,output,error}); });
    });
    child.stdin.write(`begin; set statement_timeout='8s'; ${claims(actor)}
      ${owner ? '' : 'set local role authenticated;'} ${statement}\n`);
    if (!hold) child.stdin.end('commit;\n');
    return {app,child,done,output:()=>output,finished:()=>finished};
  }
  async function until(condition,label) {
    const deadline = Date.now()+5000;
    while (!condition()) {
      if (Date.now()>deadline) throw new Error(`Timed out: ${label}`);
      await delay(15);
    }
  }
  function waitInfo(c) {
    return JSON.parse(sql(socket,database,`select coalesce(jsonb_agg(jsonb_build_object(
      'pid',a.pid,'wait_type',a.wait_event_type,'wait_event',a.wait_event,'blockers',
      (select coalesce(jsonb_agg(b.application_name order by b.application_name),'[]') from pg_stat_activity b
        where b.pid=any(pg_blocking_pids(a.pid))))),'[]')
      from pg_stat_activity a where a.application_name='${c.app}';`).trim());
  }
  async function blocked(c, blocker, label) {
    await until(()=>c.finished() || waitInfo(c).some(r=>r.wait_type==='Lock'),label);
    const info = waitInfo(c);
    assert.ok(info.some(r=>r.wait_type==='Lock' && (!blocker || r.blockers.includes(blocker.app))),
      `${label}: expected real PostgreSQL blocker ${blocker?.app ?? ''}; observed ${JSON.stringify(info)}`);
    console.log(`WAIT: ${label} ${JSON.stringify(info)}`);
    return info;
  }
  async function held(c,label) { await until(()=>c.finished() || c.output().includes('HELD'),label); assert.ok(!c.finished(),label); }
  async function finish(c,commit=true) {
    if (!c.finished() && !c.child.stdin.writableEnded) c.child.stdin.end(`${commit ? 'commit' : 'rollback'};\n`);
    return c.done;
  }
  async function success(c,label) { const r=await c.done; assert.equal(r.code,0,`${label}: ${r.error}`); return r; }
  async function denied(c,label) {
    const r=await c.done;
    assert.notEqual(r.code,0,label);
    assert.match(r.error,/42501:/,`${label}: must reject authority, not timeout/version/deadlock: ${r.error}`);
  }
  function actorSql(actor,statement) { return sql(socket,database,`begin; ${claims(actor)} set local role authenticated; ${statement} commit;`); }
  function setManager() {
    sql(socket,database,`update public.profiles set account_status='active',disabled_at=null,credentials_valid_after=clock_timestamp()-interval '1 day' where id='${user}';`);
    const role=sql(socket,database,`select app_role from public.profiles where id='${user}';`).trim();
    if (role!=='manager') actorSql(p0,`select public.update_employee_directory_role('${user}','manager','${role}');`);
    actorSql(p0,`select public.replace_subscription_management_delegates(array['${user}']::uuid[]);
      select public.replace_subscription_credential_access_grants(array['${user}']::uuid[]);`);
  }
  function snapshot() {
    return sql(socket,database,`select encode(extensions.digest(jsonb_build_object(
      'register',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]') from private.subscription_register r where service_name like 'Synthetic fence %'),
      'memberships',(select coalesce(jsonb_agg(to_jsonb(m) order by to_jsonb(m)::text),'[]') from private.subscription_memberships m join private.subscription_register r on r.id=m.subscription_id where r.service_name like 'Synthetic fence %'),
      'vault',(select coalesce(jsonb_agg(to_jsonb(v) order by v.subscription_id),'[]') from private.subscription_credential_vault v join private.subscription_register r on r.id=v.subscription_id where r.service_name like 'Synthetic fence %'),
      'audit',(select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]') from private.subscription_audit_events a join private.subscription_register r on r.id=a.subscription_id where r.service_name like 'Synthetic fence %'),
      'credential_audit',(select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]') from private.subscription_credential_audit_events a join private.subscription_register r on r.id=a.subscription_id where r.service_name like 'Synthetic fence %')
    )::text,'sha256'),'hex');`).trim();
  }
  const writers = [
    {name:'create_subscription',create:true,args:name=>`'${name}',null,'paid','monthly',100,null,'${user}','{}'::uuid[]`},
    {name:'create_subscription_v2',create:true,args:name=>`'${name}',null,'paid','monthly',100,null,1,false,current_date,'${user}','{}'::uuid[]`},
    {name:'create_subscription_v3',create:true,args:name=>`'${name}',null,'paid','monthly',100,null,1,false,null,current_date,'${user}','{}'::uuid[]`},
    {name:'create_subscription_v4',create:true,args:name=>`'${name}',null,'paid','monthly',100,null,1,false,null,current_date,'${user}','equipsy','{}'::uuid[]`},
    {name:'update_subscription',args:(name,id)=>`'${id}',1,'${name} changed',null,'active','paid','monthly',100,null,'${user}','{}'::uuid[]`},
    {name:'update_subscription_v2',args:(name,id)=>`'${id}',1,'${name} changed',null,'active','paid','monthly',100,null,1,false,current_date,'${user}','{}'::uuid[]`},
    {name:'update_subscription_v3',args:(name,id)=>`'${id}',1,'${name} changed',null,'active','paid','monthly',100,null,1,false,null,current_date,'${user}','{}'::uuid[]`},
    {name:'update_subscription_v4',args:(name,id)=>`'${id}',1,'${name} changed',null,'active','paid','monthly',100,null,1,false,null,current_date,'${user}','equipsy','{}'::uuid[]`},
    {name:'mark_subscription_reviewed',args:(_name,id)=>`'${id}',1`},
    {name:'mark_subscription_reviewed_v2',args:(_name,id)=>`'${id}',1`},
    {name:'patch_subscription_v1',args:(_name,id)=>`'${id}',1,'{"company_scope":"equipsy"}'::jsonb`},
    {name:'set_subscription_company',schema:'private',owner:true,args:(_name,id)=>`'${id}','equipsy'`},
    {name:'save_subscription_credential',vault:true,args:(_name,id)=>`'${id}',1,'U3ludGhldGlj','abcdefghijklmnop','abcdefghijklmnopqrstuv',1`},
    {name:'remove_subscription_credential',vault:true,args:(_name,id)=>`'${id}',1`},
    {name:'get_subscription_credential',vault:true,reveal:true,args:(_name,id)=>`'${id}'`},
  ];
  const effectiveNames=JSON.parse(sql(socket,database,`select jsonb_agg(n.nspname||'.'||p.proname order by n.nspname,p.proname)
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private') and p.prokind='f' and p.provolatile='v'
      and p.proname like '%subscription%' and p.proname not in ('lock_subscription_role_authority','complete_my_subscription_password_task')
      and (p.prosrc like '%public.can_manage_subscriptions()%' or p.prosrc like '%private.is_current_subscription_credential_manager()%'
        or p.prosrc like '%private.lock_subscription_role_authority(%');`).trim());
  assert.deepEqual(effectiveNames,writers.map(w=>`${w.schema ?? 'public'}.${w.name}`).sort(),'Every effective register/vault writer and audited reveal is covered');
  sql(socket,database,`insert into auth.users(id,email,email_confirmed_at) values('${user}','synthetic-fence-manager@example.test',now());
    insert into public.profiles(id,full_name,app_role,login_name,credentials_valid_after) values('${user}','Synthetic fence Manager','manager','synthetic-fence-manager',clock_timestamp()-interval '1 day');
    insert into public.internal_org_people(id,full_name,position_title,company_key,auth_user_id) values('${user}','Synthetic fence Manager','Synthetic','mam','${user}');`);
  let fixture = 0;
  function prepare(w) {
    setManager();
    const id=`c9000000-0000-4000-8000-${String(++fixture).padStart(12,'0')}`;
    const name=`Synthetic fence ${fixture} ${w.name}`;
    sql(socket,database,`insert into private.subscription_register(id,subscription_code,service_name,pricing_model,billing_cycle,amount_cents,seat_count,mam_credit_card_used,billing_anchor_date,next_review_on,responsible_person_id,company_scope)
      values('${id}','MAM-SUB-${900000+fixture}','${name}','paid','monthly',100,1,false,current_date,current_date,'${user}','mam');
      insert into private.subscription_credential_vault(subscription_id,credential_ciphertext,credential_iv,credential_auth_tag,credential_key_version,credential_version,created_by,updated_by)
      values('${id}','U3ludGhldGlj','abcdefghijklmnop','abcdefghijklmnopqrstuv',1,1,'${p0}','${p0}');`);
    const resource=w.create ? 'lock table private.subscription_register in share mode;'
      : w.reveal ? 'lock table private.subscription_credential_audit_events in share mode;'
      : w.vault ? `select pg_advisory_xact_lock(hashtextextended('mam:subscription-credential:${id}',0));`
      : `select id from private.subscription_register where id='${id}' for update;`;
    return {id,name,resource,statement:`select * from ${w.schema ?? 'public'}.${w.name}(${w.args(name,id)});`};
  }
  function revoke(w,mode) {
    return mode==='demote' ? `select public.update_employee_directory_role('${user}','account','manager');`
      : `select public.replace_subscription_${w.vault ? 'credential_access_grants' : 'management_delegates'}('{}'::uuid[]);`;
  }
  async function checked(label,work) {
    try { await work(); ++passed; console.log(`PASS: ${label}`); }
    catch (error) { failures.push({label,message:error.message}); console.log(`FAIL: ${label}: ${error.message}`); }
    finally {
      for (const c of [...sessions]) { c.stdin.end('rollback;\n'); c.kill('SIGTERM'); }
      await until(()=>sessions.size===0,'owned race session cleanup');
    }
  }
  try {
    for (const w of writers) {
      for (const mode of ['revoke','demote']) {
        await checked(`${w.name} writer-first ${mode} serializes through commit`,async()=>{
          const f=prepare(w), before=snapshot();
          const holder=connection(null,`${f.resource} select 'HELD';`,true,true);
          await held(holder,'late resource holder');
          const writer=connection(user,f.statement,false,w.owner);
          await blocked(writer,holder,`${w.name} resource wait`);
          const revoker=connection(p0,revoke(w,mode));
          await blocked(revoker,writer,`${w.name} ${mode} waits on writer authority fence`);
          assert.equal(snapshot(),before,'No resource mutation before release');
          assert.equal((await finish(holder,false)).code,0);
          await success(writer,'authorized writer');
          await success(revoker,'serialized revoker');
          assert.notEqual(snapshot(),before,'Authorized writer commits resource/audit before revocation');
          assert.equal(sql(socket,database,`select count(*) from private.${w.vault ? 'subscription_credential_audit_events' : 'subscription_audit_events'} a
            join private.subscription_register r on r.id=a.subscription_id where r.service_name like '${f.name}%'
              and a.actor_user_id='${user}';`).trim(),w.name.endsWith('_v4') ? '2' : '1','Writer retains exact real-actor audit');
          const capabilities=JSON.parse(actorSql(user,`select row_to_json(c) from public.get_portal_role_capabilities() c;`).trim().split('\n').find(s=>s.startsWith('{')));
          assert.equal(capabilities[w.vault ? 'can_manage_subscription_credentials' : 'can_manage_subscriptions'],false);
        });
        await checked(`${w.name} ${mode}-first rejects queued writer before resource`,async()=>{
          const f=prepare(w), before=snapshot();
          const holder=connection(null,`${f.resource} select 'HELD';`,true,true);
          await held(holder,'late resource holder');
          const revoker=connection(p0,`${revoke(w,mode)} select 'HELD';`,true);
          await held(revoker,'revocation authority held');
          const writer=connection(user,f.statement,false,w.owner);
          const info=await blocked(writer,revoker,`${w.name} waits on revoker before resource`);
          assert.ok(info.some(r=>r.wait_event==='advisory'),'Role-control lock is the first wait');
          const targetProbe=await connection(null,`select id from public.profiles where id='${user}' for share nowait;`,false,true).done;
          if (mode==='revoke') assert.equal(targetProbe.code,0,'Queued consumer does not lock actor before role-control');
          assert.equal((await finish(revoker)).code,0);
          await denied(writer,'Revoked/demoted queued writer');
          assert.equal(snapshot(),before,'Rejected writer leaves full resources/memberships/vault/audits unchanged');
          assert.equal((await finish(holder,false)).code,0);
        });
      }
      await checked(`${w.name} direct stale caller rejects before role/actor/resource waits`,async()=>{
        const f=prepare(w),before=snapshot();
        sql(socket,database,`update public.profiles set credentials_valid_after=clock_timestamp()+interval '1 hour' where id='${user}';`);
        const holder=connection(null,`select pg_advisory_xact_lock(hashtextextended('mam:directory-role-control',0));
          select id from public.profiles where id='${user}' for update; ${f.resource} select 'HELD';`,true,true);
        await held(holder,'all ordered fences held');
        await denied(connection(user,`set statement_timeout='700ms'; ${f.statement}`,false,w.owner),'Stale caller denies before any fence');
        assert.equal(snapshot(),before);
        assert.equal((await finish(holder,false)).code,0);
      });
    }
    for (const w of [writers.find(w=>w.name==='patch_subscription_v1'),writers.find(w=>w.name==='save_subscription_credential')]) {
      await checked(`${w.name} actor-profile wait reauthorizes disabled account before resource`,async()=>{
        const f=prepare(w),before=snapshot();
        const resource=connection(null,`${f.resource} select 'HELD';`,true,true);
        await held(resource,'late resource');
        const actor=connection(null,`update public.profiles set account_status='disabled',disabled_at=clock_timestamp() where id='${user}'; select 'HELD';`,true,true);
        await held(actor,'actor disable');
        const writer=connection(user,f.statement,false,w.owner);
        await blocked(writer,actor,`${w.name} waits on actor before resource`);
        assert.equal((await finish(actor)).code,0);
        await denied(writer,'Disabled actor after profile wait');
        assert.equal(snapshot(),before);
        assert.equal((await finish(resource,false)).code,0);
      });
    }
    assert.equal(failures.length,0,JSON.stringify(failures));
    assert.equal(passed,77,'All 15 effective consumers, both orders, independent revocation/demotion and stale/actor fences execute');
    console.log(`PASS: subscription authority concurrency ${passed}/77 scenarios across ${writers.length} effective consumers`);
  } finally {
    for (const child of sessions) { child.stdin.end('rollback;\n'); child.kill('SIGTERM'); }
  }
}
