import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { startCluster,stopCluster,createDatabase,sql,command,target } from '../scripts/local-test-postgres.mjs';

const migration='supabase/migrations/20261022003958_dual_username_email_login.sql';
const baseline=readFileSync('supabase/migrations/20260902090000_fail_closed_portal_login_hardening.sql','utf8');
const resolver=baseline.match(/create function public\.resolve_portal_login_auth_email\([\s\S]*?\$\$;/)?.[0];
const catalog=readFileSync('supabase/migrations/20261001130000_confirmed_test_identity_cleanup.sql','utf8')
  .match(/create function private\.confirmed_test_purge_schema_hash\(\)[\s\S]*?\$\$;/)?.[0];
assert.ok(resolver && catalog);
const socket=startCluster();
try {
  for(const variant of ['valid','resolver-drift','catalog-drift','acl-drift']) {
    const database='mam_test_dual_login_'+variant.replaceAll('-','_');
    createDatabase(socket,database);
    command('psql',[...target(socket,database),'-f','tests/employee-email-login.sql']);
    sql(socket,database,`create schema storage; create schema extensions; create extension pgcrypto with schema extensions;
      alter table public.internal_org_people add column position_title text,add column company_key text;
      create table private.confirmed_test_identity_purges(id uuid primary key);
      create table private.confirmed_test_purge_schema(singleton boolean primary key default true,schema_hash text);
      ${resolver.replace('create function','create or replace function')}
      ${catalog}
      revoke all on function private.confirmed_test_purge_schema_hash() from public,anon,authenticated,service_role;
      insert into private.confirmed_test_purge_schema(schema_hash) select private.confirmed_test_purge_schema_hash();`);
    const digest=()=>sql(socket,database,`select encode(extensions.digest((select jsonb_build_object(
      'auth',(select jsonb_agg(to_jsonb(t)) from auth.users t),
      'profiles',(select jsonb_agg(to_jsonb(t)) from public.profiles t),
      'people',(select jsonb_agg(to_jsonb(t)) from public.internal_org_people t),
      'audit',(select jsonb_agg(to_jsonb(t)) from private.portal_account_admin_events t))::text),'sha256'),'hex');`).trim();
    if(variant==='valid') {
      const before=digest();
      command('psql',[...target(socket,database),'-f',migration]);
      assert.equal(digest(),before,'migration must not change account, password or employee records');
      command('psql',[...target(socket,database),'-f','tests/dual-username-email-login.sql']);
      console.log('PASS real PostgreSQL dual-login scenarios, permissions, password identity and unchanged migration data');
      continue;
    }
    if(variant==='resolver-drift') sql(socket,database,"create or replace function public.resolve_portal_login_auth_email(p_login_name text) returns text language sql stable security definer set search_path='' as $$ select null::text $$;");
    if(variant==='acl-drift') sql(socket,database,'grant execute on function public.resolve_portal_login_auth_email(text) to authenticated;');
    if(variant==='catalog-drift') sql(socket,database,'create table public.unreviewed_dual_login_fixture(id integer);');
    else sql(socket,database,'update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash();');
    assert.throws(()=>command('psql',[...target(socket,database),'-f',migration]),/Dual login .* (differs|catalog)/i);
    console.log('PASS migration rejects '+variant);
  }
} finally {
  stopCluster(socket);
  rmSync(socket,{recursive:true,force:true});
}
