import { readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { startCluster, stopCluster, createDatabase, sql, command, target, postgresEnv } from '../scripts/local-test-postgres.mjs';
import { runP0ActionBoundary } from './helpers/unified-role-p0-action-boundary.mjs';
const evidence = process.env.MAM_AUTH_COUNTER_EVIDENCE;
assert.ok(evidence && existsSync(evidence));
const socket = startCluster(), database = 'mam_test_reset_auth_boundary';
const id = n => `a1000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const results = [];
const digest = () => createHash('sha256').update(sql(socket,database,`select jsonb_build_object('auth',(select jsonb_agg(to_jsonb(r) order by id) from auth.users r),'profiles',(select jsonb_agg(to_jsonb(r) order by id) from public.profiles r),'people',(select jsonb_agg(to_jsonb(r) order by id) from public.internal_org_people r),'claims',(select jsonb_agg(to_jsonb(r) order by auth_user_id) from private.portal_password_reset_claims r),'audits',(select jsonb_agg(to_jsonb(r) order by id) from private.portal_account_admin_events r),'credentials',(select jsonb_agg(to_jsonb(r) order by id) from private.employee_onboarding_credentials r),'credential_events',(select jsonb_agg(to_jsonb(r) order by id) from private.employee_onboarding_credential_events r));`)).digest('hex');
try {
  createDatabase(socket,database);
  sql(socket,database,readFileSync('tests/migrations/0001-supabase-platform.sql','utf8'));
  for (const file of readdirSync('supabase/migrations').filter(f => f.endsWith('.sql')).sort()) sql(socket,database,readFileSync('supabase/migrations/'+file,'utf8'));
  command('psql',[...target(socket,database),'-f','tests/unified-role-concurrency-setup.sql']);
  sql(socket,database,`insert into public.internal_org_people(id,full_name,position_title,company_key,is_active) values ('${id(17)}','Synthetic Unlinked','Tester','mam',true);`);
  for (const n of [5,9]) {
    const before = digest();
    const result = await runP0ActionBoundary(socket,database,id(4),id(n),'reset');
    results.push({target:n,...result,unchanged:digest()===before});
  }
  writeFileSync(evidence+'/boundary.json',JSON.stringify(results,null,2));
  console.log(JSON.stringify(results.map(({target,authCalls,targetAuthReads,targetAuthMutations,actorSessionAuthCalls,unchanged,results})=>({target,authCalls,targetAuthReads,targetAuthMutations,actorSessionAuthCalls,unchanged,rejected:results[0].rejected}))));
  for (const result of results) {
    assert.equal(result.unchanged,true);
    assert.equal(result.results[0].rejected,true);
    assert.equal(result.actorSessionAuthCalls,1,'Required actor session authentication is excluded from target calls');
    assert.equal(result.authCalls,result.targetAuthReads+result.targetAuthMutations);
    assert.equal(result.authCalls,0,'Unauthorized P0 reset must reject before ALL target Auth provider calls');
  }
  for (const [label,actorId,targetId,resetInput] of [
    ['stale-version',4,1,{accountVersion:2}],
    ['wrong-user-link',4,1,{userId:id(2)}],
    ['standalone-unlinked',9,9,{}],
    ['unlinked-person',4,17,{userId:id(1)}],
  ]) {
    const before=digest();
    const result=await runP0ActionBoundary(socket,database,id(actorId),id(targetId),'reset',{resetInput});
    assert.equal(result.results[0].rejected,true,label);
    assert.equal(result.authCalls,0,label);
    assert.equal(result.calls.includes('begin_portal_password_reset'),false,label);
    assert.equal(digest(),before,label);
    results.push({label,...result,unchanged:true});
  }
  for (const [label,actorId,targetId] of [['authorized-p0',9,5],['authorized-ordinary',4,1]]) {
    const result=await runP0ActionBoundary(socket,database,id(actorId),id(targetId),'reset',{providerSuccess:true});
    assert.equal(result.results[0].rejected,false,label);
    assert.equal(result.results[0].hasOneTimePassword,true,label);
    assert.equal(result.results[0].account.accountVersion,2,label);
    assert.equal(result.results[0].account.lastSignInAt,'2026-01-01T00:00:00Z',label);
    assert.equal(result.results[0].account.userId,id(targetId),label);
    assert.equal(result.authCalls,2,label);
    assert.equal(result.targetAuthReads,1,label);
    assert.equal(result.targetAuthMutations,1,label);
    assert.deepEqual(result.events,['can_manage_portal_accounts','begin_portal_password_reset','target-auth-update','finalise_portal_password_reset','target-auth-read'],label);
    results.push({label,...result});
  }
  const uncertain=await runP0ActionBoundary(socket,database,id(4),id(2),'reset');
  assert.equal(uncertain.results[0].rejected,true);
  assert.equal(uncertain.targetAuthMutations,1);
  assert.equal(uncertain.targetAuthReads,0);
  assert.equal(uncertain.calls.includes('finalise_portal_password_reset'),false);
  assert.equal(sql(socket,database,`select count(*) from private.portal_password_reset_claims where auth_user_id='${id(2)}';`).trim(),'1');
  results.push({label:'uncertain-provider-preserves-claim',...uncertain});
  const beforeRetry=digest();
  const retry=await runP0ActionBoundary(socket,database,id(4),id(2),'reset',{providerSuccess:true});
  assert.equal(retry.results[0].rejected,true);
  assert.equal(retry.authCalls,0);
  assert.equal(digest(),beforeRetry);
  results.push({label:'pending-reset-rejects-provider-retry',...retry,unchanged:true});
  writeFileSync(evidence+'/boundary.json',JSON.stringify(results,null,2));
  console.log('PASS '+results.length+' focused actual action/database checks');
} finally {
  const pid = Number(readFileSync(socket+'/data/postmaster.pid','utf8').split('\n')[0]);
  stopCluster(socket);
  const status = spawnSync('pg_ctl',['-D',socket+'/data','status'],{env:postgresEnv}).status;
  let alive = false; try { process.kill(pid,0); alive = true; } catch {}
  rmSync(socket,{recursive:true,force:true});
  writeFileSync(evidence+'/cleanup.json',JSON.stringify({pid,status,alive,removed:!existsSync(socket)}));
  assert.equal(status,3); assert.equal(alive,false); assert.equal(existsSync(socket),false);
}
