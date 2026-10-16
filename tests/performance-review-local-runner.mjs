import assert from 'node:assert/strict';
import { readFileSync,existsSync,writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {startCluster,createDatabase,stopCluster,target,postgresEnv} from '../scripts/local-test-postgres.mjs';
const root=process.cwd();
export function psql(socket,database,query) {
 const r=spawnSync('psql',[...target(socket,database),'-Atq'],{env:postgresEnv,input:query,encoding:'utf8'});
 if(r.stderr) process.stderr.write(r.stderr);if(r.status!==0){console.error(r.stdout);throw Error(`Local SQL failed (${r.status})`);}return r.stdout;
}
function definition(file,marker) {
 const source=readFileSync(path.join(root,'supabase/migrations',file),'utf8');const start=source.indexOf(marker);assert.ok(start>=0,marker);
 const tail=source.slice(start);const tag=/\bas\s+(\$[a-zA-Z_]*\$)/i.exec(tail);assert.ok(tag);
 const end=tail.indexOf(tag[1],tag.index+tag[0].length);assert.ok(end>0,marker);const terminator=/^\s*;/.exec(tail.slice(end+tag[1].length));assert.ok(terminator);
 return tail.slice(0,end+tag[1].length+terminator[0].length);
}
export function setup(socket,database) {
 createDatabase(socket,database);
 psql(socket,database,readFileSync('tests/performance-review-sql-fixture.sql','utf8'));
 for(const [file,marker] of [
 ['20260813051743_portal_account_management.sql','create function private.is_active_portal_account('],
 ['20261008110000_subscription_employee_delegation.sql','CREATE OR REPLACE FUNCTION private.portal_role_policy('],
 ['20261006104000_unified_portal_roles.sql','create function private.lock_portal_role_actor()'],
 ['20261006104000_unified_portal_roles.sql','create function public.get_portal_role_capabilities('],
 ['20261006104000_unified_portal_roles.sql','CREATE OR REPLACE FUNCTION private.resolve_internal_org_employee_manager('],
 ['20261001130000_confirmed_test_identity_cleanup.sql','create function private.confirmed_test_has_reference('],
 ['20261001140000_confirmed_test_purge_delivered_leave_history.sql','create or replace function private.reject_retired_test_identity_reference()']
 ]) psql(socket,database,definition(file,marker));
 psql(socket,database,'revoke all on function public.get_portal_role_capabilities(uuid) from public,anon,authenticated,service_role; grant execute on function public.get_portal_role_capabilities(uuid) to authenticated;');
 console.log('NATIVE_CLUSTER '+psql(socket,database,"select jsonb_build_object('version',current_setting('server_version'),'listenAddresses',current_setting('listen_addresses'),'database',current_database());").trim());
 if(existsSync('deploy/uat/performance-review-schema.sql')) psql(socket,database,readFileSync('deploy/uat/performance-review-schema.sql','utf8'));
}
export async function ownedRun(run) {
 let socket;let success=false;
 try {socket=startCluster();console.log(JSON.stringify({scope:'schema-only synthetic prerequisite; NOT GoTrue or full Hub replay',socket,tcp:false}));await run(socket);success=true;}
 finally {if(socket){stopCluster(socket);const status=spawnSync('pg_ctl',['-D',path.join(socket,'data'),'status'],{env:postgresEnv,encoding:'utf8'});const cleanup={socket,stopped:status.status===3,pidFileAbsent:!existsSync(path.join(socket,'data/postmaster.pid')),socketAbsent:!existsSync(path.join(socket,'.s.PGSQL.55439')),businessRunPassed:success};console.log('OWNED_CLEANUP '+JSON.stringify(cleanup));assert.ok(cleanup.stopped&&cleanup.pidFileAbsent&&cleanup.socketAbsent);writeFileSync(path.join(root,'qa-evidence/uat-20261016/backend-owner',`cleanup-${path.basename(socket)}.json`),JSON.stringify(cleanup,null,2));writeFileSync(path.join(root,'qa-evidence/uat-20261016/backend-owner',`cluster-${path.basename(socket)}.postgres.log`),readFileSync(path.join(socket,'postgres.log')));}}
}
if(process.argv[1]===new URL(import.meta.url).pathname) await ownedRun(async socket=>{const database='mam_test_performance';setup(socket,database);if(process.argv[2]==='--actions') await (await import('./performance-review-sql-bridge.mjs')).runPerformanceActionSqlBridge(socket,database);else console.log(psql(socket,database,readFileSync('tests/performance-review-security.sql','utf8')));});
