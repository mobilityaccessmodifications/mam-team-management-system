import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { command, createDatabase, sql, target } from '../../scripts/local-test-postgres.mjs';

export function runUnifiedRoleTransitionRegressions(socket) {
  const file='supabase/migrations/20261006104000_unified_portal_roles.sql';
  const source=readFileSync(file,'utf8');
  const sourceHash=createHash('sha256').update(readFileSync(file)).digest('hex');
  const anchor='update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;';
  assert.equal(source.split(anchor).length,2,'One exact forward fingerprint transition anchor');
  const predecessor='mam_test_unified_role_transition_predecessor';
  createDatabase(socket,predecessor);
  sql(socket,predecessor,readFileSync('tests/migrations/0001-supabase-platform.sql','utf8'));
  const history=readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql') && f<path.basename(file)).sort();
  const historyHashes=history.map(f=>[f,createHash('sha256').update(readFileSync(path.join('supabase/migrations',f))).digest('hex')]);
  for (const f of history) sql(socket,predecessor,readFileSync(path.join('supabase/migrations',f),'utf8'));
  const before=sql(socket,predecessor,`select private.confirmed_test_purge_schema_hash();`).trim();
  assert.equal(before,sql(socket,predecessor,'select schema_hash from private.confirmed_test_purge_schema;').trim());
  const faults=[
    ['composite','create type private.unreviewed_marker as (marker text);'],
    ['domain','create domain private.unreviewed_marker as uuid check (value is not null);'],
    ['column','alter table private.subscription_management_grant_events add column unreviewed_marker integer;'],
    ['trigger',`create trigger unreviewed_marker before insert on private.subscription_management_grant_events for each row execute function private.reject_retired_test_identity_reference();`],
    ['constraint',`alter table private.subscription_management_grant_events add constraint unreviewed_marker check (cardinality(after_person_ids)<20);`],
    ['table_acl','grant select on private.subscription_management_grant_events to authenticated;'],
    ['column_acl','grant select(actor_user_id) on private.subscription_management_grant_events to service_role;'],
    ['function_acl','grant execute on function public.replace_subscription_management_delegates(uuid[]) to service_role;'],
    ['function_body',`create or replace function private.is_operational_portal_admin() returns boolean language sql stable security definer set search_path='' as $$ select false; $$;`],
  ];
  const failures=[];
  let passed=0;
  for (const [label,fault] of faults) {
    for (const phase of ['pre','post']) {
      const database=`mam_test_unified_role_transition_${phase}_${label}`;
      command('createdb',['-h',socket,'-p','55439','-U','postgres',`--template=${predecessor}`,database]);
      try {
        const injected=source.replace(anchor,()=>phase==='pre' ? `${fault}\n${anchor}` : `${anchor}\n${fault}`);
        let result;
        try { command('psql',[...target(socket,database),'-v','VERBOSITY=verbose','-Atq'],{input:injected,maxBuffer:16*1024*1024}); result='committed'; }
        catch (error) { result=error.message; }
        const catalog=sql(socket,database,'select private.confirmed_test_purge_schema_hash();').trim();
        const baseline=sql(socket,database,'select schema_hash from private.confirmed_test_purge_schema;').trim();
        const newObjects=sql(socket,database,`select to_regclass('private.subscription_management_grant_events') is not null
          or to_regprocedure('public.get_portal_role_capabilities(uuid)') is not null;`).trim();
        const denied=result.includes('55000:');
        const clean=catalog===before && baseline===before && newObjects==='f';
        if (!denied || !clean) {
          failures.push({label,phase,denied,atomic_rollback:clean,result:result==='committed' ? result : result.slice(0,400)});
          console.log(`FAIL: role transition ${phase}-${label} denied=${denied} atomic_rollback=${clean}`);
        } else { ++passed; console.log(`PASS: role transition ${phase}-${label} rejects unreviewed drift with full atomic rollback`); }
      } finally { command('dropdb',['-h',socket,'-p','55439','-U','postgres',database]); }
    }
  }
  const valid='mam_test_unified_role_transition_valid';
  command('createdb',['-h',socket,'-p','55439','-U','postgres',`--template=${predecessor}`,valid]);
  try {
    sql(socket,valid,source);
    assert.equal(sql(socket,valid,'select private.confirmed_test_purge_schema_hash()=(select schema_hash from private.confirmed_test_purge_schema);').trim(),'t');
    assert.equal(sql(socket,valid,`select to_regprocedure('public.get_portal_role_capabilities(uuid)') is not null;`).trim(),'t');
    ++passed;
    console.log('PASS: exact role metadata delta commits and preserves usable purge fingerprint');
  } finally {
    command('dropdb',['-h',socket,'-p','55439','-U','postgres',valid]);
    command('dropdb',['-h',socket,'-p','55439','-U','postgres',predecessor]);
  }
  assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'),sourceHash,'Candidate source stayed frozen during fault tests');
  assert.deepEqual(history.map(f=>[f,createHash('sha256').update(readFileSync(path.join('supabase/migrations',f))).digest('hex')]),historyHashes,'Applied migration bytes stayed frozen');
  assert.equal(failures.length,0,JSON.stringify(failures));
  assert.equal(passed,2*faults.length+1,'Every actual source injection and the legitimate transition executed');
  console.log(`PASS: unified-role guarded catalog transition ${passed}/${2*faults.length+1}; ${history.length} unchanged predecessors; migration SHA ${sourceHash}`);
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) runUnifiedRoleTransitionRegressions(process.argv[2]);
