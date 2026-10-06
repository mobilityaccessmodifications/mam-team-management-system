#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes, createHmac, createHash, createCipheriv, randomUUID } from 'node:crypto';
import Module from 'node:module';
import { build } from 'esbuild';
import { capabilityColumns, expectedCapabilities, historicalGrantFixture, leaveFixture } from './helpers/unified-role-auth-fixtures.mjs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = 'a470987af20b2cb97bd8e3143eab426623cda527';
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--baseline'), 'Only --baseline is supported; no remote target or credentials accepted');
const mode = args.length ? 'baseline' : 'candidate';
const host = 'unix:///Users/nixon/.colima/mam-cleanup-e2e/docker.sock';
const config = '/Users/nixon/.hermes/profiles/mam/cache/scratch/docker-mam-cleanup';
const images = {
  db: 'postgres:17.6@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929',
  auth: 'supabase/gotrue:v2.189.0@sha256:385184459f57569c54c25209f51f3b2be99ddd7c4ce9e3555b5d3eea8447b7cf',
  rest: 'postgrest/postgrest:v14.12@sha256:54000f24847d01a2c2302e0041cf0618b875c57fb48507d743cfa9aaa50bf43c',
};
const label = 'mam.unified-role-auth';
const prefix = `mam-unified-role-auth-${randomBytes(8).toString('hex')}`;
const runLabel = `${label}.run=${prefix}`;
const names = { db: `${prefix}-db`, auth: `${prefix}-auth`, rest: `${prefix}-rest` };
const volume = `${prefix}-data`;
const database = 'mam_test_unified_role_auth';
const secret = randomBytes(48).toString('hex');
const dbPassword = randomBytes(24).toString('hex');
const env = { PATH: process.env.PATH, HOME: config, DOCKER_HOST: host, DOCKER_CONFIG: config };
const resources = { containers: [], network: false, volume: false };
const checks = [];
let gateway;
let activeCheck = 'bootstrap';
let failed = false;

function command(executable, commandArgs, input) {
  return spawnSync(executable, commandArgs, { cwd: root, env, input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120000 });
}
function docker(commandArgs, input, allowFailure = false) {
  const result = command('env', [`DOCKER_HOST=${host}`, `DOCKER_CONFIG=${config}`, 'docker', ...commandArgs], input);
  if (!allowFailure && (result.error || result.status !== 0)) {
    const state = result.stderr?.match(/(?:ERROR|FATAL):\s+([0-9A-Z]{5}):?/)?.[1];
    const functions = [...new Set([...String(result.stderr).matchAll(/(?:PL\/pgSQL|SQL) function ([a-z_.0-9]+)\(/g)].map(match => match[1]))];
    throw new Error(`Isolated Docker ${commandArgs[0]} failed (exit ${result.status ?? 'unavailable'}${state ? `, SQLSTATE ${state}` : ''}${functions.length ? `, functions ${functions.join(',')}` : ''}; raw output withheld)`);
  }
  return result;
}
function text(commandArgs, input, allowFailure = false) { return (docker(commandArgs, input, allowFailure).stdout ?? '').trim(); }
function sql(query) {
  return text(['exec', '-i', names.db, 'psql', '-X', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-Atq'], query);
}
function appFingerprint() {
  return sql("with definitions as (select n.nspname||'.'||p.oid::text as name,pg_get_functiondef(p.oid) as body from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prokind='f' union all select n.nspname||'.trigger.'||t.oid::text,pg_get_triggerdef(t.oid)||t.tgenabled::text from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','auth') and not t.tgisinternal) select md5(string_agg(body,E'\\n' order by name)) from definitions;");
}
function source(path) {
  if (mode === 'candidate') return readFileSync(resolve(root, path), 'utf8');
  const result = command('git', ['show', `${baseline}:${path}`]);
  assert.equal(result.status, 0, `Immutable baseline source unavailable: ${path}`);
  return result.stdout;
}
function migrationSources() {
  let files;
  if (mode === 'baseline') {
    const result = command('git', ['ls-tree', '--name-only', baseline, 'supabase/migrations/']);
    assert.equal(result.status, 0, 'Immutable baseline migration tree unavailable');
    files = result.stdout.trim().split('\n').filter(path => path.endsWith('.sql'));
  } else {
    files = readdirSync(resolve(root, 'supabase/migrations')).filter(path => path.endsWith('.sql')).map(path => `supabase/migrations/${path}`);
  }
  return files.sort().map(path => ({ path, sql: source(path) }));
}
const migrations = migrationSources();
const platformSource = source('tests/migrations/0001-supabase-platform.sql');
const contractSource = source('tests/migrations/effective-contract.sql');
const manifest = createHash('sha256').update(JSON.stringify(migrations)).digest('hex');
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
async function ready(check, name) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if (await check()) return; } catch {}
    await delay(300);
  }
  throw new Error(`${name} readiness failed; service logs withheld`);
}
function jwt(role) {
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ role, aud: 'authenticated', iss: 'synthetic-local', iat: now, exp: now + 3600 })).toString('base64url');
  return `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}
const serviceKey = jwt('service_role');
const anonKey = jwt('anon');
function ok(result, name = 'provider operation') {
  if (result.error) throw new Error(`${name}: rejected (${result.error.code ?? 'no code'}, HTTP ${result.error.status ?? result.status ?? 'unknown'})`);
  return result.data;
}
async function denied(client, rpc, params = {}, codes = ['42501']) {
  const result = await client.rpc(rpc, params);
  assert.ok(result.error, `${rpc} must reject`);
  assert.ok(codes.includes(result.error?.code), `${rpc} must reject for authorization/contract, not missing implementation (${result.error?.code ?? 'no code'})`);
  assert.ok(result.status < 500 || result.error.code === '55000', `${rpc} must not fail through a provider/server outage`);
}
async function capabilities(client, personId = null) {
  const rows = ok(await client.rpc('get_portal_role_capabilities', { p_person_id: personId }), 'get_portal_role_capabilities');
  assert.equal(rows.length, 1, 'Canonical RPC returns exactly one row');
  assert.deepEqual(Object.keys(rows[0]).sort(), [...capabilityColumns].sort(), 'Canonical capability row must have the exact approved columns');
  return rows[0];
}
async function legacyCapabilities(client, expected) {
  const mapping = {
    can_manage_portal_accounts: 'can_manage_accounts',
    can_view_employee_directory: 'can_view_employee_directory',
    can_manage_employee_directory: 'can_manage_employee_directory',
    can_view_organisation_chart: 'can_view_organisation_chart',
    can_edit_internal_org: 'can_edit_organisation_chart',
    can_change_employee_view: 'can_change_employee_view',
    can_view_employee_check_in_workspace: 'can_view_check_in_workspace',
    can_manage_it_assets: 'can_manage_assets',
    can_view_subscription_register: 'can_view_subscription_register',
    can_manage_subscriptions: 'can_manage_subscriptions',
    can_manage_subscription_credentials: 'can_manage_subscription_credentials',
    can_manage_subscription_credential_grants: 'can_manage_subscription_credential_grants',
    can_manage_analytics_api: 'can_manage_analytics_api',
    can_import_payroll_balances: 'can_import_payroll_balances',
    can_view_all_leave_requests: 'can_view_all_leave_requests',
    can_review_leave_workspace: 'can_review_leave_workspace',
    can_approve_employee_check_in_employment_decision: 'can_approve_employment_decisions',
  };
  for (const [rpc, column] of Object.entries(mapping)) {
    assert.equal(ok(await client.rpc(rpc), rpc), expected[column], `${rpc} agrees with canonical ${column}`);
  }
  const workspace = ok(await client.rpc('get_portal_workspace_capabilities'), 'legacy workspace capabilities');
  assert.equal(workspace.length, 1, 'Legacy workspace returns one row');
  for (const [column, value] of Object.entries(workspace[0])) {
    if (Object.hasOwn(expected, column)) assert.equal(value, expected[column], `Legacy workspace ${column} agrees with canonical policy`);
  }
}
async function check(name, run, required = false) {
  activeCheck = name;
  try {
    await run();
    checks.push({ name, status: 'pass' });
    console.log(`PASS ${String(checks.length).padStart(2, '0')} ${name}`);
  } catch (error) {
    failed = true;
    checks.push({ name, status: 'fail' });
    console.error(`FAIL ${name}: ${String(error.message).split('\n')[0].slice(0, 300)}`);
    if (required || mode === 'baseline') throw error;
  }
}
function runContainer(name, extra, image) {
  text(['run', '-d', '--name', name, '--label', `${label}=true`, '--label', runLabel, '--network', prefix, ...extra, image]);
  resources.containers.push(name);
}
function apiPort(name, port) {
  const bindings = JSON.parse(text(['inspect', name, '--format', '{{json .NetworkSettings.Ports}}']))[`${port}/tcp`];
  assert.equal(bindings.length, 1, 'Exactly one API binding expected');
  assert.equal(bindings[0].HostIp, '127.0.0.1', 'API must be loopback only');
  return `http://127.0.0.1:${bindings[0].HostPort}`;
}

try {
  console.log(`SCHEMA ${mode}${mode === 'baseline' ? ` ${baseline}` : ''} migrations=${migrations.length} sha256=${manifest}`);
  assert.equal(text(['info', '--format', '{{.ServerVersion}}']), '29.5.2', 'Only the approved dedicated daemon is supported');
  for (const image of Object.values(images)) {
    let inspected = docker(['image', 'inspect', image, '--format', '{{.Id}}'], undefined, true);
    if (inspected.status !== 0) {
      text(['pull', image]);
      inspected = docker(['image', 'inspect', image, '--format', '{{.Id}}']);
    }
    const id = inspected.stdout.trim();
    assert.equal(id, image.split('@')[1], 'Pinned image ID changed');
    console.log(`IMAGE ${image} ID ${id}`);
  }
  text(['network', 'create', '--label', `${label}=true`, '--label', runLabel, prefix]);
  resources.network = true;
  text(['volume', 'create', '--label', `${label}=true`, '--label', runLabel, volume]);
  resources.volume = true;
  runContainer(names.db, ['--network-alias', 'db', '--mount', `type=volume,src=${volume},dst=/var/lib/postgresql/data`, '-e', `POSTGRES_PASSWORD=${dbPassword}`, '-e', `POSTGRES_DB=${database}`], images.db);
  await ready(() => text(['exec', names.db, 'psql', '-X', '-U', 'postgres', '-d', database, '-Atqc', 'select 1'], undefined, true) === '1', 'PostgreSQL');
  assert.equal(text(['inspect', names.db, '--format', '{{json .HostConfig.PortBindings}}']), '{}', 'Database must have no published host port');
  sql(`create role supabase_auth_admin login noinherit password '${dbPassword}'; create schema auth authorization supabase_auth_admin; alter role supabase_auth_admin set search_path=auth;`);
  runContainer(names.auth, ['-p', '127.0.0.1::9999', '-e', 'GOTRUE_API_HOST=0.0.0.0', '-e', 'GOTRUE_API_PORT=9999', '-e', 'API_EXTERNAL_URL=http://127.0.0.1:9999', '-e', 'GOTRUE_SITE_URL=http://127.0.0.1', '-e', 'GOTRUE_DB_DRIVER=postgres', '-e', `GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:${dbPassword}@db:5432/${database}`, '-e', 'GOTRUE_DB_NAMESPACE=auth', '-e', `GOTRUE_JWT_SECRET=${secret}`, '-e', 'GOTRUE_JWT_ADMIN_ROLES=service_role', '-e', 'GOTRUE_JWT_AUD=authenticated', '-e', 'GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated', '-e', 'GOTRUE_EXTERNAL_EMAIL_ENABLED=true', '-e', 'GOTRUE_MAILER_AUTOCONFIRM=true', '-e', 'GOTRUE_DISABLE_SIGNUP=true', '-e', 'LOG_LEVEL=error'], images.auth);
  const authUrl = apiPort(names.auth, 9999);
  await ready(async () => (await fetch(`${authUrl}/health`, { signal: AbortSignal.timeout(3000) })).ok, 'GoTrue');
  assert.ok(Number(sql('select count(*) from auth.schema_migrations;')) > 0, 'GoTrue must run its own migrations');
  const providerFunctions = sql("select md5(string_agg(pg_get_functiondef(p.oid),E'\n' order by p.proname)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='auth' and p.proname in ('uid','jwt','role');");
  assert.equal(sql("select bool_and(pg_get_userbyid(c.relowner)='supabase_auth_admin') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='auth' and c.relname in ('users','identities','sessions');"), 't', 'Provider owns real Auth tables');
  const platform = platformSource.replace('create schema auth;', '').replace(/create table auth\.users \([\s\S]*?\n\);/, '').replace(/create function auth\.(uid|jwt|role)\(\)[\s\S]*?\n\$\$;/g, '');
  assert.equal(/create (?:schema auth|table auth\.|function auth\.)/.test(platform), false, 'Fake Auth prerequisites must be fully removed');
  sql(platform);
  sql(`create role authenticator login noinherit password '${dbPassword}'; grant anon,authenticated,service_role to authenticator;`);
  for (const migration of migrations) {
    try { sql(migration.sql); } catch (error) { throw new Error(`${migration.path}: ${error.message}`); }
  }
  assert.equal(providerFunctions, sql("select md5(string_agg(pg_get_functiondef(p.oid),E'\n' order by p.proname)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='auth' and p.proname in ('uid','jwt','role');"), 'Application replay must not replace provider Auth helpers');
  console.log(`PASS full unchanged application replay (${migrations.length} migrations); GoTrue owns actual Auth schema`);
  const listeningAssertion = "  assert current_setting('listen_addresses') = '', 'Replay must not listen on TCP';";
  assert.ok(contractSource.includes(listeningAssertion), 'Expected infrastructure-only assertion must exist');
  sql(contractSource.replace(listeningAssertion, ''));
  console.log('PASS effective schema/RLS/ACL contract; private Docker TCP, database has no host port');
  assert.equal(sql('select count(*) from auth.users; select count(*) from public.profiles; select count(*) from public.internal_org_people;'), '0\n0\n0', 'Fresh provider/application replay contains no staff data');
  const applicationFingerprint = appFingerprint();
  assert.deepEqual(JSON.parse(text(['inspect', names.db, '--format', '{{json .Mounts}}'])).filter(mount => mount.Type === 'volume').map(mount => mount.Name), [volume], 'Only the exact labelled disposable DB volume may be attached');
  runContainer(names.rest, ['-p', '127.0.0.1::3000', '-e', `PGRST_DB_URI=postgres://authenticator:${dbPassword}@db:5432/${database}`, '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', `PGRST_JWT_SECRET=${secret}`], images.rest);
  const restUrl = apiPort(names.rest, 3000);
  await ready(async () => (await fetch(`${restUrl}/`, { signal: AbortSignal.timeout(3000) })).ok, 'PostgREST');
  gateway = createServer(async (request, response) => {
    try {
      const isAuth = request.url.startsWith('/auth/v1/');
      const isRest = request.url.startsWith('/rest/v1/');
      if (!isAuth && !isRest) { response.writeHead(404); response.end(); return; }
      const route = request.url.slice(isAuth ? '/auth/v1'.length : '/rest/v1'.length);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const upstream = await fetch((isAuth ? authUrl : restUrl) + route, {
        method: request.method,
        headers: { authorization: request.headers.authorization ?? '', apikey: request.headers.apikey ?? '', 'content-type': request.headers['content-type'] ?? 'application/json' },
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : body,
        signal: AbortSignal.timeout(15000),
      });
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      response.end(await upstream.text());
    } catch (error) {
      console.error(`LOCAL_TRANSPORT ${JSON.stringify({ kind: error.name, cause: error.cause?.code ?? null })}`);
      if (error.name === 'TimeoutError') {
        console.error('LOCAL_SQL_STATE ' + sql("select coalesce(jsonb_agg(jsonb_build_object('state',state,'wait_type',wait_event_type,'wait_event',wait_event,'blockers',cardinality(pg_blocking_pids(pid)),'role_rpc',query like '%update_employee_directory_role%','query_age_seconds',round(extract(epoch from clock_timestamp()-query_start)::numeric,2),'transaction_age_seconds',round(extract(epoch from clock_timestamp()-xact_start)::numeric,2))),'[]'::jsonb) from pg_stat_activity where backend_type='client backend' and pid<>pg_backend_pid();"));
        const logs = docker(['logs', names.db], undefined, true);
        console.error(`LOCAL_ROLE_CONFLICT_ERRORS ${([...String(logs.stdout).matchAll(/Role has changed\. Refresh and try again\./g), ...String(logs.stderr).matchAll(/Role has changed\. Refresh and try again\./g)]).length}`);
      }
      response.writeHead(502, { 'content-type': 'application/json' }); response.end('{"code":"local_gateway_failure"}');
    }
  });
  await new Promise(resolveListen => gateway.listen(0, '127.0.0.1', resolveListen));
  const base = `http://127.0.0.1:${gateway.address().port}`;
  const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
  const provider = createClient(base, serviceKey, options);
  const fixtures = [];
  async function account(name, role = 'employee', linked = true) {
    const email = `${name}@example.test`;
    const password = randomBytes(24).toString('hex');
    const user = ok(await provider.auth.admin.createUser({ email, password, email_confirm: true }), 'GoTrue createUser').user;
    assert.ok(user.id, 'Provider-generated identity required');
    sql(`insert into public.profiles(id,full_name,app_role,login_name,account_status,credentials_valid_after) values ('${user.id}','Synthetic ${name}','${role}','${email}','active',now()-interval '1 day');`);
    if (linked) {
      sql(`insert into public.internal_org_people(id,full_name,company_key,position_title,auth_user_id,is_active) values ('${user.id}','Synthetic ${name}','mam','Synthetic role','${user.id}',true);
        insert into private.employee_directory_details(person_id,first_name,last_name,employment_type,work_email,date_of_birth,team_name)
        values ('${user.id}','Synthetic','${name}','full_time','${email}','1990-02-03','Major');`);
    }
    const client = createClient(base, anonKey, options);
    const session = ok(await client.auth.signInWithPassword({ email, password }), 'GoTrue signInWithPassword').session;
    assert.ok(session?.access_token, 'Actual signed-in provider JWT required');
    const claims = JSON.parse(Buffer.from(session.access_token.split('.')[1], 'base64url').toString());
    assert.equal(claims.sub, user.id, 'Provider JWT subject must match actual Auth identity');
    assert.ok(claims.session_id, 'Provider JWT must represent an actual session');
    assert.equal(sql(`select count(*) from auth.sessions where id='${claims.session_id}' and user_id='${user.id}';`), '1', 'Actual GoTrue session must exist');
    const fixture = { id: user.id, client, token: session.access_token, iat: claims.iat, sessionId: claims.session_id, name, role };
    fixtures.push(fixture);
    return fixture;
  }
  const p0 = await account('standalone-p0', 'system_admin', false);
  sql(`insert into private.portal_account_admins(auth_user_id) values ('${p0.id}');`);
  await check('standalone P0 retains existing signed-JWT Change profile authority', async () => {
    assert.equal(ok(await p0.client.rpc('can_change_employee_view'), 'P0 legacy capability'), true);
    assert.equal(sql(`select count(*) from public.internal_org_people where auth_user_id='${p0.id}';`), '0', 'P0 remains standalone');
  });
  await check('canonical standalone P0 capability RPC returns the approved row', async () => {
    assert.deepEqual(await capabilities(p0.client), expectedCapabilities('system_admin', null), 'Standalone P0 preserves its full operational and exclusive capability set');
    const noParameter = ok(await p0.client.rpc('get_portal_role_capabilities'), 'canonical default argument');
    assert.deepEqual(noParameter[0], await capabilities(p0.client), 'Omitted and explicit NULL canonical target agree');
  }, true);
  const p0ProfileSnapshot = sql(`select md5(to_jsonb(p)::text) from public.profiles p where id='${p0.id}';`);
  const p0AuthSnapshot = ok(await provider.auth.admin.getUserById(p0.id), 'P0 Auth readback').user;
  const p0Expected = expectedCapabilities('system_admin', null);
  async function setRole(user, role, expectedRole = user.role) {
    const actual = ok(await p0.client.rpc('update_employee_directory_role', { p_person_id: user.id, p_role: role, p_expected_role: expectedRole }), 'P0 compare-and-set role setter');
    assert.equal(actual, role, 'Role setter returns the exact approved role');
    assert.equal(sql(`select app_role from public.profiles where id='${user.id}';`), role, 'Role mutation is read back from its exact target');
    user.role = role;
  }
  const users = {};
  await check('actual GoTrue sessions receive all four roles through the real P0 CAS setter', async () => {
    for (const role of ['employee', 'manager', 'account', 'admin']) {
      users[role] = await account(role);
      await setRole(users[role], role);
    }
    assert.equal(sql(`select count(*) from private.employee_directory_audit_events where actor_user_id='${p0.id}' and changed_fields=array['app_role']::text[];`), '3', 'Only the three actual role changes create real-P0 audit events');
    assert.equal(sql(`select count(*) from auth.sessions where user_id in ('${p0.id}',${Object.values(users).map(user => `'${user.id}'`).join(',')});`), '5', 'P0 and all four roles have actual provider sessions');
  }, true);
  for (const [role, user] of Object.entries(users)) {
    await check(`${role} default and P0-target canonical reads match the approved matrix`, async () => {
      const expected = expectedCapabilities(role, user.id);
      assert.deepEqual(await capabilities(user.client), expected, `${role} default capability matrix`);
      assert.deepEqual(await capabilities(p0.client, user.id), expected, `${role} preview must use target policy, never actual-P0 policy`);
      await legacyCapabilities(user.client, expected);
      assert.deepEqual(await capabilities(p0.client), p0Expected, 'Preview never changes actual P0 account/session authority');
    });
  }
  await check('P0 legacy capability APIs agree and the private policy has no client/service ACL', async () => {
    await legacyCapabilities(p0.client, p0Expected);
    assert.equal(sql("select not has_function_privilege('anon','private.portal_role_policy(uuid)','execute') and not has_function_privilege('authenticated','private.portal_role_policy(uuid)','execute') and not has_function_privilege('service_role','private.portal_role_policy(uuid)','execute');"), 't', 'Private canonical target helper is inaccessible to browser/service roles');
  });
  const protectedP0 = await account('protected-linked-p0', 'system_admin');
  for (const [role, user] of Object.entries(users)) {
    await check(`${role} cannot change roles, preview, manage P0 security or delegate grants`, async () => {
      await denied(user.client, 'update_employee_directory_role', { p_person_id: users.employee.id, p_role: 'admin', p_expected_role: 'employee' });
      await denied(user.client, 'get_portal_role_capabilities', { p_person_id: user.id });
      await denied(user.client, 'list_employee_directory_roles');
      await denied(user.client, 'list_leave_calendar_entries_for_preview', { p_person_id: users.employee.id });
      await denied(user.client, 'list_analytics_api_keys');
      await denied(user.client, 'set_portal_account_admin', { p_auth_user_id: users.employee.id, p_is_admin: true });
      await denied(user.client, 'replace_subscription_credential_access_grants', { p_person_ids: [] });
      await denied(user.client, 'list_subscription_management_delegates');
      await denied(user.client, 'replace_subscription_management_delegates', { p_person_ids: [] });
      const directWrite = await user.client.from('profiles').update({ app_role: 'system_admin' }).eq('id', user.id);
      assert.equal(directWrite.error?.code, '42501', 'Direct PostgREST role-column write is rejected by actual ACL');
      assert.equal(sql(`select app_role from public.profiles where id='${user.id}';`), role, 'Unauthorized writes do not change the target role');
    });
  }
  await check('ordinary role editing cannot assign system_admin or modify an existing P0', async () => {
    await denied(p0.client, 'update_employee_directory_role', { p_person_id: users.employee.id, p_role: 'system_admin', p_expected_role: 'employee' }, ['23514']);
    await denied(p0.client, 'update_employee_directory_role', { p_person_id: protectedP0.id, p_role: 'employee', p_expected_role: 'system_admin' });
    assert.equal(sql(`select app_role from public.profiles where id='${protectedP0.id}';`), 'system_admin', 'Existing linked P0 cannot be demoted through the ordinary editor');
    assert.equal(p0ProfileSnapshot, sql(`select md5(to_jsonb(p)::text) from public.profiles p where id='${p0.id}';`), 'Standalone P0 profile is unchanged');
  });
  const accountOther = await account('account-alternate-name');
  await setRole(accountOther, 'account');
  const managerOther = await account('ungranted-manager');
  await setRole(managerOther, 'manager');
  const outside = await account('outside-reporting');
  const equipsy = await account('equipsy-person');
  const archivedMam = await account('archived-mam');
  const archivedEquipsy = await account('archived-equipsy');
  sql(`update public.internal_org_people set parent_id='${users.manager.id}' where id in ('${users.employee.id}','${users.account.id}');
    update public.internal_org_people set company_key='equipsy' where id in ('${equipsy.id}','${archivedEquipsy.id}');
    update private.employee_directory_details set team_name='Equipsy' where person_id in ('${equipsy.id}','${archivedEquipsy.id}');
    insert into private.leave_approval_grants(reviewer_user_id,scope_kind,reviewer_label,priority)
      values ('${p0.id}','global','Synthetic P0 reviewer',100);
    insert into private.manager_leave_reviewers(reviewer_user_id,priority) values ('${p0.id}',100);`);
  const leaveRecords = [
    leaveFixture(users.employee),
    leaveFixture(outside, 'submitted', { dateOffset: 91 }),
    leaveFixture(equipsy, 'submitted', { dateOffset: 92 }),
    leaveFixture(outside, 'approved', { dateOffset: 93 }),
    leaveFixture(equipsy, 'approved', { dateOffset: 94 }),
    leaveFixture(outside, 'rejected', { dateOffset: 95 }),
    leaveFixture(equipsy, 'changes_requested', { dateOffset: 96 }),
    leaveFixture(outside, 'cancelled', { dateOffset: 97 }),
    leaveFixture(archivedMam, 'approved', { dateOffset: -98, historical: true }),
    leaveFixture(archivedEquipsy, 'approved', { dateOffset: -99, historical: true }),
  ];
  for (const record of leaveRecords) {
    activeCheck = `synthetic leave fixture ${fixtures.find(fixture => fixture.id === record.ownerId).name} ${record.status}`;
    sql(record.sql);
  }
  activeCheck = 'synthetic archived fixture state';
  sql(`update public.profiles set account_status='disabled',disabled_at=now() where id in ('${archivedMam.id}','${archivedEquipsy.id}');
    update public.internal_org_people set is_active=false where id in ('${archivedMam.id}','${archivedEquipsy.id}');`);
  const [reportPending, outsidePending] = leaveRecords;
  const futureDate = sql('select private.next_victorian_business_day(current_date+120);');
  const submitArgs = personId => ({ p_submission_key: randomUUID(), p_person_id: personId, p_request_type_label: 'Unpaid leave', p_start_date: futureDate, p_end_date: futureDate, p_employee_note: 'Synthetic self-service note' });
  for (const [role, user] of Object.entries(users)) {
    await check(`${role} retains own profile/leave and evidence metadata lifecycle (no Storage HTTP)`, async () => {
      const profile = ok(await user.client.rpc('get_my_employee_profile'), 'self profile');
      assert.equal(profile.length, 1, 'Own active employee profile remains available');
      const args = submitArgs(null);
      const submitted = ok(await user.client.rpc('submit_leave_request_once', args), 'self leave submit')[0];
      assert.ok(submitted.id, 'Actual self leave mutation returns its identifier');
      assert.equal(sql(`select user_id::text from public.leave_requests where id='${submitted.id}';`), user.id, 'Self leave is durably owned by the real provider identity');
      const retried = ok(await user.client.rpc('submit_leave_request_once', args), 'self leave idempotent retry')[0];
      assert.equal(retried.id, submitted.id, 'Actual retry cannot create a second leave record');
      await denied(user.client, 'decide_leave_with_balance', { p_request_id: submitted.id, p_status: 'Approved' });
      const plan = ok(await user.client.rpc('prepare_my_leave_request_attachment_upload', { p_request_id: submitted.id, p_file_name: 'synthetic-own.pdf', p_mime_type: 'application/pdf', p_size_bytes: 128 }), 'own attachment metadata upload plan')[0];
      assert.ok(plan.storage_path, 'Metadata plan is issued for the own request');
      sql(`insert into storage.objects(bucket_id,name,owner,owner_id,metadata) values ('leave-evidence','${plan.storage_path}','${user.id}','${user.id}','{"size":128,"mimetype":"application/pdf"}'::jsonb);`);
      const attachment = ok(await user.client.rpc('complete_my_leave_request_attachment_upload', { p_storage_path: plan.storage_path }), 'complete against explicit synthetic Storage metadata')[0];
      assert.equal(attachment.leave_request_id, submitted.id, 'Real completion registers exact request metadata');
      assert.equal(ok(await user.client.rpc('can_download_leave_request_attachment', { p_attachment_id: attachment.id }), 'own evidence authorization'), true, 'Own evidence download authorization is retained; no file delivery asserted');
      ok(await user.client.rpc('delete_my_leave_request_attachment', { p_attachment_id: attachment.id }), 'own metadata deletion');
      assert.equal(sql(`select count(*) from public.leave_request_attachments where id='${attachment.id}';`), '0', 'Exact own attachment metadata is absent after deletion');
      assert.equal(sql(`select count(*) from storage.objects where bucket_id='leave-evidence' and name='${plan.storage_path}';`), '1', 'Synthetic Storage row remains: metadata deletion is not object-byte deletion');
      ok(await user.client.rpc('cancel_my_approved_leave_request', { p_request_id: submitted.id }), 'own leave cancellation');
      assert.equal(sql(`select status from public.leave_requests where id='${submitted.id}';`), 'cancelled', 'Own cancellation is read back');
    });
  }
  for (const user of [users.account, accountOther]) {
    await check(`${user === users.account ? 'first' : 'alternate-name'} Account reads all-status cross-company leave, notes and evidence metadata`, async () => {
      const rows = ok(await user.client.rpc('list_leave_workspace_requests'), 'Account all-status leave register');
      const records = rows.filter(row => leaveRecords.some(record => record.id === row.id));
      assert.deepEqual(records.map(row => row.id).sort(), leaveRecords.map(record => record.id).sort(), 'Account sees every exact fixture across both companies including archived approved history');
      assert.deepEqual([...new Set(records.map(row => row.status))].sort(), ['Approved', 'Cancelled', 'Declined', 'Pending'], 'Account register contains all released statuses');
      for (const row of records) {
        assert.equal(row.employee_note, 'Synthetic employee note', 'Approved Account scope retains existing employee notes');
        assert.equal(row.manager_note, 'Synthetic retained reviewer note', 'Approved Account scope retains existing reviewer notes');
        assert.equal(row.can_decide, false, 'Read access never confers decision authority');
        assert.equal(row.can_cancel, false, 'Read access never confers other-owner cancellation');
        assert.equal(row.can_attach, false, 'Read access never confers other-owner upload');
      }
      const evidence = ok(await user.client.rpc('list_leave_workspace_attachments'), 'Account evidence metadata');
      assert.deepEqual(evidence.filter(row => leaveRecords.some(record => record.attachment === row.id)).map(row => row.id).sort(), leaveRecords.map(record => record.attachment).sort(), 'Account reads all existing evidence metadata in its approved scope');
      for (const attachment of evidence) {
        assert.equal(Object.hasOwn(attachment, 'storage_path'), false, 'Metadata projection never exposes object paths');
        assert.equal(attachment.can_delete, false, 'Account cannot delete other uploaders metadata');
      }
      for (const record of leaveRecords) assert.equal(ok(await user.client.rpc('can_download_leave_request_attachment', { p_attachment_id: record.attachment }), 'Account evidence authorization only'), true, 'Account retains approved evidence download authorization, not proven HTTP delivery');
    });
    await check(`${user === users.account ? 'first' : 'alternate-name'} Account calendar includes pending staff and retained approved cross-company history`, async () => {
      const calendar = ok(await user.client.rpc('list_leave_calendar_entries_with_teams'), 'Account calendar');
      for (const record of leaveRecords.filter(record => record.status === 'submitted' || record.status === 'approved')) assert.ok(calendar.some(row => row.id === record.id), `Account calendar includes ${record.status} ${fixtures.find(fixture => fixture.id === record.ownerId).name} fixture`);
      assert.equal(calendar.some(row => leaveRecords.some(record => record.id === row.id && ['rejected', 'cancelled', 'changes_requested'].includes(record.status))), false, 'Calendar is not the all-status private register');
      const preview = ok(await p0.client.rpc('list_leave_calendar_entries_with_teams_for_preview', { p_person_id: user.id }), 'Account exact P0 calendar preview');
      assert.deepEqual(calendar, preview, 'Actual Account and P0-target calendar projections agree without impersonation');
    });
    await check(`${user === users.account ? 'first' : 'alternate-name'} Account has own birthdays and no check-in review`, async () => {
      const birthdays = ok(await user.client.rpc('list_calendar_birthdays'), 'Account own birthday');
      assert.equal(birthdays.length, 1, 'Account does not gain global birthday visibility');
      await denied(user.client, 'list_employee_check_in_workspace');
    });
  }
  await check('Account cannot decide/cancel-other/on-behalf/upload/delete/edit balances or enter vault', async () => {
    const user = users.account;
    const snapshot = sql(`select md5(to_jsonb(r)::text) from public.leave_requests r where id='${reportPending.id}'; select md5(to_jsonb(a)::text) from public.leave_request_attachments a where id='${reportPending.attachment}';`);
    await denied(user.client, 'decide_leave_with_balance', { p_request_id: reportPending.id, p_status: 'Approved' });
    await denied(user.client, 'decide_my_managed_leave_request', { p_request_id: reportPending.id, p_status: 'Approved' });
    await denied(user.client, 'cancel_my_approved_leave_request', { p_request_id: reportPending.id });
    await denied(user.client, 'submit_leave_request_once', submitArgs(users.employee.id));
    await denied(user.client, 'prepare_my_leave_request_attachment_upload', { p_request_id: reportPending.id, p_file_name: 'synthetic-other.pdf', p_mime_type: 'application/pdf', p_size_bytes: 128 });
    await denied(user.client, 'delete_my_leave_request_attachment', { p_attachment_id: reportPending.attachment });
    await denied(user.client, 'set_employee_annual_leave_balance', { p_person_id: users.employee.id, p_hours: 999, p_as_of: sql('select current_date;'), p_is_example: false });
    await denied(user.client, 'set_employee_leave_accrual_policy', { p_person_id: users.employee.id, p_weekly_hours: 38, p_annual_weeks: 4, p_personal_weeks: 2, p_shiftworker: false, p_enabled: true, p_note: 'Synthetic unauthorized setting' });
    await denied(user.client, 'list_subscription_credential_catalogue');
    const direct = await user.client.from('leave_requests').update({ status: 'approved' }).eq('id', reportPending.id).select('id');
    assert.ok((direct.error?.code === '42501') || (!direct.error && direct.data.length === 0), 'Actual leave RLS/ACL denies direct Account approval');
    assert.equal(snapshot, sql(`select md5(to_jsonb(r)::text) from public.leave_requests r where id='${reportPending.id}'; select md5(to_jsonb(a)::text) from public.leave_request_attachments a where id='${reportPending.attachment}';`), 'All rejected Account operations leave exact targets unchanged');
  });
  await check('Manager keeps reporting-scoped decisions/on-behalf, not global or self authority', async () => {
    const rows = ok(await users.manager.client.rpc('list_leave_workspace_requests'), 'Manager leave scope');
    assert.equal(rows.find(row => row.id === reportPending.id)?.can_decide, true, 'Manager can decide a current reporting descendant');
    assert.equal(rows.some(row => row.id === outsidePending.id), false, 'Manager does not read unrelated pending private leave');
    await denied(users.manager.client, 'decide_leave_with_balance', { p_request_id: outsidePending.id, p_status: 'Approved' });
    const submitted = ok(await users.manager.client.rpc('submit_leave_request_once', submitArgs(users.employee.id)), 'Manager reporting on-behalf submit')[0];
    assert.ok(submitted.id, 'Manager on-behalf submission succeeds only for reporting descendant');
    assert.equal(sql(`select employee_person_id::text from public.leave_requests where id='${submitted.id}';`), users.employee.id, 'On-behalf target is exact reporting employee');
    assert.equal(sql(`select actor_user_id::text from public.leave_request_events where leave_request_id='${submitted.id}' and event_type='submitted';`), users.manager.id, 'On-behalf audit actor is actual Manager, not target');
    const decided = ok(await users.manager.client.rpc('decide_leave_with_balance', { p_request_id: reportPending.id, p_status: 'Approved', p_manager_note: 'Synthetic scoped decision' }), 'Manager scoped decision');
    assert.equal(decided[0].id, reportPending.id, 'Scoped decision returns exact target');
    assert.equal(sql(`select status from public.leave_requests where id='${reportPending.id}';`), 'approved', 'Manager reporting decision is durable');
    await denied(users.manager.client, 'submit_leave_request_once', submitArgs(outside.id));
  });
  let subscription;
  const subscriptionCreateArgs = {
    p_service_name: 'Synthetic role-bound service', p_plan_name: 'Synthetic plan', p_pricing_model: 'paid',
    p_billing_cycle: 'monthly', p_amount_cents: 1200, p_renewal_date: futureDate, p_seat_count: 4,
    p_credit_card_used: false, p_credit_card_holder: null, p_billing_anchor_date: sql('select current_date;'),
    p_responsible_person_id: users.employee.id, p_member_person_ids: [users.employee.id],
  };
  await check('P0/Admin operational subscription rights remain available without delegation', async () => {
    subscription = ok(await p0.client.rpc('create_subscription_v3', subscriptionCreateArgs), 'P0 operational subscription create');
    assert.ok(subscription.subscription_id, 'Actual register creation returns its identity');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', randomBytes(32), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ password: randomBytes(24).toString('hex') }), 'utf8'), cipher.final()]);
    ok(await p0.client.rpc('save_subscription_credential', {
      p_subscription_id: subscription.subscription_id, p_expected_credential_version: 0,
      p_credential_ciphertext: ciphertext.toString('base64url'), p_credential_iv: iv.toString('base64url'),
      p_credential_auth_tag: cipher.getAuthTag().toString('base64url'), p_credential_key_version: 1,
    }), 'P0 synthetic encrypted-vault save');
    assert.equal(sql(`select count(*) from private.subscription_credential_vault where subscription_id='${subscription.subscription_id}';`), '1', 'Exact encrypted synthetic credential record exists');
    assert.equal(ok(await users.admin.client.rpc('get_subscription_credential', { p_subscription_id: subscription.subscription_id }), 'Admin operational vault read').length, 1, 'Ordinary Admin retains operational vault access, not grant management');
    const adminCreated = ok(await users.admin.client.rpc('create_subscription_v3', { ...subscriptionCreateArgs, p_service_name: 'Synthetic Admin service' }), 'Admin operational register create');
    assert.equal(sql(`select count(*) from private.subscription_register where id='${adminCreated.subscription_id}' and created_by='${users.admin.id}';`), '1', 'Admin operational mutation keeps actual actor audit');
  }, true);
  await check('ungranted Managers read the credential-free register but cannot write or open vault', async () => {
    for (const user of [users.manager, managerOther]) {
      const register = ok(await user.client.rpc('list_subscriptions_v2'), 'Manager read-only register');
      assert.ok(register.some(row => row.subscription_id === subscription.subscription_id), 'Default Manager can read the register');
      assert.equal(/credential_ciphertext|credential_iv|credential_auth_tag/.test(JSON.stringify(register)), false, 'Register never exposes encrypted vault material');
      await denied(user.client, 'patch_subscription_v1', { p_subscription_id: subscription.subscription_id, p_expected_version: subscription.version, p_patch: { subscription_status: 'paused' } });
      await denied(user.client, 'get_subscription_credential', { p_subscription_id: subscription.subscription_id });
    }
  });
  await check('P0 management-only and vault-only Manager delegates are independent and audited', async () => {
    ok(await p0.client.rpc('replace_subscription_management_delegates', { p_person_ids: [users.manager.id] }), 'P0 management delegation');
    ok(await p0.client.rpc('replace_subscription_credential_access_grants', { p_person_ids: [managerOther.id] }), 'P0 vault delegation');
    const delegates = ok(await p0.client.rpc('list_subscription_management_delegates'), 'P0 management delegate readback');
    assert.ok(delegates.some(row => row.person_id === users.manager.id), 'Exact management delegate is read back through real RPC');
    assert.deepEqual(delegates, ok(await p0.client.rpc('list_subscription_management_delegates'), 'deterministic delegate DTO read'), 'Delegate DTO/order is deterministic');
    assert.equal(sql(`select count(*) from private.subscription_management_grants where person_id='${users.manager.id}';`), '1', 'Exact management grant is durable');
    assert.equal(sql(`select count(*) from private.subscription_credential_access_grants where person_id='${managerOther.id}' and auth_user_id='${managerOther.id}' and granted_by='${p0.id}';`), '1', 'Vault delegation records actual P0 actor');
    for (const [user, grants] of [[users.manager, { management: true }], [managerOther, { vault: true }]]) {
      const expected = expectedCapabilities('manager', user.id, grants);
      assert.deepEqual(await capabilities(user.client), expected, 'Independent actual Manager delegation matrix');
      assert.deepEqual(await capabilities(p0.client, user.id), expected, 'Independent Manager preview matches its actual grant policy');
      await legacyCapabilities(user.client, expected);
    }
    const patched = ok(await users.manager.client.rpc('patch_subscription_v1', { p_subscription_id: subscription.subscription_id, p_expected_version: subscription.version, p_patch: { subscription_status: 'paused' } }), 'management-only Manager real register mutation');
    assert.equal(patched.id, subscription.subscription_id, 'Existing patch DTO identifies the same exact subscription');
    subscription = { ...subscription, version: patched.version };
    assert.equal(sql(`select subscription_status from private.subscription_register where id='${subscription.subscription_id}';`), 'paused', 'Management-only mutation is read back');
    await denied(users.manager.client, 'get_subscription_credential', { p_subscription_id: subscription.subscription_id });
    assert.equal(ok(await managerOther.client.rpc('get_subscription_credential', { p_subscription_id: subscription.subscription_id }), 'vault-only Manager real read').length, 1, 'Vault-only Manager receives the encrypted record');
    await denied(managerOther.client, 'patch_subscription_v1', { p_subscription_id: subscription.subscription_id, p_expected_version: subscription.version, p_patch: { subscription_status: 'active' } });
  });
  await check('P0 grant revocation is immediate for existing JWTs and preserves independent authority', async () => {
    ok(await p0.client.rpc('replace_subscription_management_delegates', { p_person_ids: [] }), 'management revocation');
    assert.equal(sql(`select count(*) from private.subscription_management_grants where person_id='${users.manager.id}';`), '0', 'Management revocation is read back');
    assert.deepEqual(await capabilities(users.manager.client), expectedCapabilities('manager', users.manager.id), 'Existing Manager JWT loses management after revocation');
    assert.deepEqual(await capabilities(managerOther.client), expectedCapabilities('manager', managerOther.id, { vault: true }), 'Management revocation cannot revoke independent vault grant');
    await denied(users.manager.client, 'patch_subscription_v1', { p_subscription_id: subscription.subscription_id, p_expected_version: subscription.version, p_patch: { subscription_status: 'active' } });
    ok(await p0.client.rpc('replace_subscription_credential_access_grants', { p_person_ids: [] }), 'vault revocation');
    assert.equal(sql(`select count(*) from private.subscription_credential_access_grants where person_id='${managerOther.id}';`), '0', 'Vault revocation is read back');
    assert.deepEqual(await capabilities(managerOther.client), expectedCapabilities('manager', managerOther.id), 'Existing Manager JWT loses vault after revocation');
    await denied(managerOther.client, 'get_subscription_credential', { p_subscription_id: subscription.subscription_id });
    await denied(p0.client, 'replace_subscription_management_delegates', { p_person_ids: [users.account.id] }, ['22023', '42501']);
    await denied(p0.client, 'replace_subscription_credential_access_grants', { p_person_ids: [users.account.id] }, ['22023', '42501']);
  });
  const parserBuild = await build({
    stdin: { contents: source('src/lib/payroll-balance-import.ts'), sourcefile: 'src/lib/payroll-balance-import.ts', resolveDir: resolve(root, 'src/lib'), loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'cjs',
    plugins: [{ name: 'packaging-marker-only', setup(builder) {
      builder.onResolve({ filter: /^server-only$/ }, () => ({ path: 'server-only', namespace: 'local-test' }));
      builder.onLoad({ filter: /.*/, namespace: 'local-test' }, () => ({ contents: '' }));
    } }],
  });
  const parserModule = new Module(resolve(root, 'tests/helpers/unified-role-auth-parser.cjs'));
  parserModule.filename = resolve(root, 'tests/helpers/unified-role-auth-parser.cjs');
  parserModule.paths = Module._nodeModulePaths(root);
  parserModule._compile(parserBuild.outputFiles[0].text, parserModule.filename);
  const parser = parserModule.exports;
  const asOf = sql("select (clock_timestamp() at time zone 'Australia/Melbourne')::date;");
  const csv = Buffer.from(`Company,Employee,Annual leave,Sick leave,As Of\nmam,Synthetic employee,38,25,${asOf}\nequipsy,Synthetic equipsy-person,50,20,${asOf}\n`);
  const uploadFile = (name, bytes) => ({ name, type: 'text/csv', size: bytes.length, arrayBuffer: async () => bytes });
  let parsed;
  let comparison;
  let archive;
  function balanceSnapshot() {
    return sql("select md5(coalesce(jsonb_agg(to_jsonb(t) order by person_id)::text,'[]')) from private.employee_annual_leave_balances t; select md5(coalesce(jsonb_agg(to_jsonb(t) order by person_id)::text,'[]')) from private.employee_sick_leave_balances t; select count(*) from private.annual_leave_balance_history; select count(*) from private.sick_leave_balance_history;");
  }
  await check('Account real CSV parsing, service staging and database comparison are read-only (no Storage HTTP)', async () => {
    for (const [personId, hours] of [[users.employee.id, 50], [equipsy.id, 70]]) {
      ok(await p0.client.rpc('set_employee_annual_leave_balance', { p_person_id: personId, p_hours: hours, p_as_of: asOf, p_is_example: false }), 'P0 fixture balance setup');
    }
    const before = balanceSnapshot();
    const prepared = await parser.preparePayrollBalanceFiles([uploadFile('synthetic-balances.csv', csv)]);
    archive = ok(await provider.rpc('prepare_payroll_balance_source_archive', { p_actor_user_id: users.account.id, p_original_file_name: prepared[0].name, p_content_type: prepared[0].mimeType, p_size_bytes: prepared[0].sizeBytes, p_source_sha256: prepared[0].sha256 }), 'service archive metadata prepare');
    sql(`insert into storage.objects(bucket_id,name,metadata) values ('payroll-balance-archives','${archive.storagePath}',jsonb_build_object('size',${csv.length},'mimetype','text/csv'));`);
    ok(await provider.rpc('complete_payroll_balance_source_archive', { p_actor_user_id: users.account.id, p_archive_id: archive.archiveId }), 'service archive completion against synthetic Storage metadata');
    parsed = await parser.parsePreparedPayrollBalanceFiles(prepared);
    assert.equal(parsed.rows.length, 2, 'Actual parser recognises both approved companies');
    assert.deepEqual(parsed.files[0].companies, ['equipsy', 'mam'], 'Real parser preserves explicit companies');
    assert.equal(parsed.rows.find(row => row.companyKey === 'mam').annualHours, 38, 'Actual CSV parser reads fixture hours');
    const params = { p_actor_user_id: users.account.id, p_source_digest: parsed.sourceDigest, p_files: parsed.files, p_rows: parsed.rows };
    await denied(users.account.client, 'stage_payroll_balance_import', params);
    comparison = ok(await provider.rpc('stage_payroll_balance_import', params), 'trusted service stages Account comparison');
    assert.equal(comparison.comparisonOnly, true, 'Every Account import is comparison-only without personal allowlist');
    assert.equal(comparison.rows.filter(row => row.status === 'linked').length, 2, 'Both same-company synthetic identities are actually reconciled');
    assert.equal(comparison.comparisonRows.length, 4, 'Actual DB comparison persists annual and sick comparisons');
    assert.ok(comparison.differenceCount > 0, 'Actual comparison flags differences/missing balances');
    assert.equal(before, balanceSnapshot(), 'Account staging/comparison writes no balances or balance history');
    ok(await provider.rpc('link_payroll_balance_source_archives', { p_actor_user_id: users.account.id, p_archive_ids: [archive.archiveId], p_batch_id: comparison.batchId }), 'service archive link');
    assert.equal(sql(`select parse_status='parsed' and batch_id='${comparison.batchId}'::uuid and uploaded_by='${users.account.id}'::uuid and retain_until>=uploaded_at+interval '30 days' from private.payroll_balance_source_archives where id='${archive.archiveId}';`), 't', 'Archive metadata is linked and retains at least thirty days');
    const reopen = ok(await users.account.client.rpc('get_payroll_balance_import_batch', { p_batch_id: comparison.batchId }), 'Account reopen saved comparison');
    assert.deepEqual(reopen.comparisonRows, comparison.comparisonRows, 'Uploader sees its existing immutable comparison');
    await denied(accountOther.client, 'get_payroll_balance_import_batch', { p_batch_id: comparison.batchId });
  }, true);
  await check('Account current/legacy commit bypasses reject and comparisons remain immutable after balance changes', async () => {
    const before = balanceSnapshot();
    for (const client of [users.account.client, users.admin.client, p0.client]) {
      await denied(client, 'commit_payroll_balance_import', { p_batch_id: comparison.batchId, p_expected_version: comparison.version });
      await denied(client, 'commit_payroll_balance_import_before_comparison', { p_batch_id: comparison.batchId, p_expected_version: comparison.version });
    }
    await denied(provider, 'stage_payroll_balance_import_before_comparison', { p_actor_user_id: users.account.id, p_source_digest: parsed.sourceDigest, p_files: parsed.files, p_rows: parsed.rows });
    assert.equal(before, balanceSnapshot(), 'Every rejected current/legacy commit leaves balances and history unchanged');
    const snapshot = sql(`select rows::text from private.payroll_balance_comparisons where batch_id='${comparison.batchId}';`);
    ok(await users.admin.client.rpc('set_employee_annual_leave_balance', { p_person_id: users.employee.id, p_hours: 55, p_as_of: asOf, p_is_example: false }), 'Admin operational manual balance update');
    const retried = ok(await provider.rpc('stage_payroll_balance_import', { p_actor_user_id: users.account.id, p_source_digest: parsed.sourceDigest, p_files: parsed.files, p_rows: parsed.rows }), 'comparison idempotent retry');
    assert.equal(retried.batchId, comparison.batchId, 'Comparison retry reuses the existing open batch');
    assert.equal(snapshot, sql(`select rows::text from private.payroll_balance_comparisons where batch_id='${comparison.batchId}';`), 'Existing comparison rows remain immutable after a real balance change');
    assert.deepEqual(retried.comparisonRows, comparison.comparisonRows, 'Saved comparison API remains immutable');
  });
  await check('parse-failed payroll archive metadata is retained and cleanup cannot remove it early (no upload delivery)', async () => {
    const badCsv = Buffer.from('invalid,no balance headers\nsynthetic,not a payroll export\n');
    const prepared = await parser.preparePayrollBalanceFiles([uploadFile('synthetic-invalid.csv', badCsv)]);
    const failedArchive = ok(await provider.rpc('prepare_payroll_balance_source_archive', { p_actor_user_id: users.account.id, p_original_file_name: prepared[0].name, p_content_type: prepared[0].mimeType, p_size_bytes: prepared[0].sizeBytes, p_source_sha256: prepared[0].sha256 }), 'failed-parse archive metadata plan');
    sql(`insert into storage.objects(bucket_id,name,metadata) values ('payroll-balance-archives','${failedArchive.storagePath}',jsonb_build_object('size',${badCsv.length},'mimetype','text/csv'));`);
    ok(await provider.rpc('complete_payroll_balance_source_archive', { p_actor_user_id: users.account.id, p_archive_id: failedArchive.archiveId }), 'failed-parse archive metadata completion');
    await assert.rejects(parser.parsePreparedPayrollBalanceFiles(prepared), 'Real malformed CSV parser must reject');
    ok(await provider.rpc('mark_payroll_balance_source_archives_failed', { p_actor_user_id: users.account.id, p_archive_ids: [failedArchive.archiveId] }), 'actual failed parsing metadata mutation');
    assert.equal(sql(`select parse_status='failed' and deleted_at is null and retain_until>=uploaded_at+interval '30 days' from private.payroll_balance_source_archives where id='${failedArchive.archiveId}';`), 't', 'Parsing failure retains the exact prepared archive metadata');
    const expired = ok(await provider.rpc('list_expired_payroll_balance_source_archives'), 'retention metadata eligibility');
    assert.equal(expired.some(row => [failedArchive.archiveId, archive.archiveId].includes(row.archive_id)), false, 'Fresh parsed and failed archives are not cleanup eligible');
    assert.equal(ok(await provider.rpc('complete_payroll_balance_source_archive_deletion', { p_archive_ids: [failedArchive.archiveId] }), 'early cleanup metadata refusal'), 0, 'Cleanup cannot mark a retained source deleted early');
    assert.equal(sql(`select parse_status from private.payroll_balance_source_archives where id='${failedArchive.archiveId}';`), 'failed', 'Exact failed-parse archive remains after early cleanup');
  });
  await check('P0/Admin real parsed payroll commits update DB balances once (no Storage HTTP)', async () => {
    const frozenComparison = sql(`select rows::text from private.payroll_balance_comparisons where batch_id='${comparison.batchId}';`);
    for (const user of [users.admin, p0]) {
      const offset = user === users.admin ? 0 : 1;
      const bytes = Buffer.from(`Company,Employee,Annual leave,Sick leave,As Of\nmam,Synthetic employee,${46 + offset},${27 + offset},${asOf}\nequipsy,Synthetic equipsy-person,${59 + offset},${22 + offset},${asOf}\n`);
      const input = await parser.parsePreparedPayrollBalanceFiles(await parser.preparePayrollBalanceFiles([uploadFile('synthetic-operational-balances.csv', bytes)]));
      const staged = ok(await provider.rpc('stage_payroll_balance_import', { p_actor_user_id: user.id, p_source_digest: input.sourceDigest, p_files: input.files, p_rows: input.rows }), 'trusted service stages operational import');
      assert.equal(staged.comparisonOnly, false, 'Actual Admin/P0 importer is not comparison-only');
      await denied(users.account.client, 'commit_payroll_balance_import', { p_batch_id: staged.batchId, p_expected_version: staged.version });
      const committed = ok(await user.client.rpc('commit_payroll_balance_import', { p_batch_id: staged.batchId, p_expected_version: staged.version }), 'actual signed-JWT operational payroll commit');
      assert.equal(committed.batchId, staged.batchId, 'Operational commit returns the exact staged batch');
      assert.equal(committed.status, 'committed', 'Operational batch is actually committed');
      assert.equal(sql(`select batch_status='committed' and uploaded_by='${user.id}'::uuid from private.payroll_balance_import_batches where id='${staged.batchId}';`), 't', 'Exact committed batch and real uploader are read back');
      for (const row of input.rows) {
        const personId = row.companyKey === 'mam' ? users.employee.id : equipsy.id;
        const balances = JSON.parse(sql(`select jsonb_build_object('annual',a.hours,'sick',s.hours,'imported',ia.batch_id='${staged.batchId}'::uuid and si.batch_id='${staged.batchId}'::uuid) from private.employee_annual_leave_balances a join private.employee_sick_leave_balances s using(person_id) join private.payroll_balance_imports ia on ia.id=a.source_import_id join private.payroll_balance_imports si on si.id=s.source_import_id where a.person_id='${personId}';`));
        assert.deepEqual(balances, { annual: row.annualHours, sick: row.sickHours, imported: true }, 'Exact synthetic balances and authoritative import provenance are read back');
      }
      const snapshot = balanceSnapshot();
      const retry = ok(await user.client.rpc('commit_payroll_balance_import', { p_batch_id: staged.batchId, p_expected_version: staged.version }), 'operational commit idempotent retry');
      assert.equal(retry.batchId, staged.batchId, 'Operational retry returns the same committed batch');
      assert.equal(balanceSnapshot(), snapshot, 'Operational retry creates no duplicate balance writes or history');
    }
    assert.equal(sql(`select rows::text from private.payroll_balance_comparisons where batch_id='${comparison.batchId}';`), frozenComparison, 'Account comparison remains immutable after actual operational payroll commits');
  });
  function grantCounts(user) {
    return sql(`select jsonb_build_object(
      'leave',(select count(*) from private.leave_approval_grants where reviewer_user_id='${user.id}' and scope_kind='global'),
      'check_in',(select count(*) from private.employee_check_in_access_grants where reviewer_user_id='${user.id}' and scope_kind='global'),
      'payroll',(select count(*) from private.payroll_balance_import_grants where person_id='${user.id}'),
      'leave_read',(select count(*) from private.leave_register_read_grants where person_id='${user.id}'),
      'management',(select count(*) from private.subscription_management_grants where person_id='${user.id}'),
      'vault',(select count(*) from private.subscription_credential_access_grants where person_id='${user.id}'))::text;`);
  }
  await check('Account and Employee historical personal grants cannot override their identical-role policy', async () => {
    const beforeAccount = await capabilities(users.account.client);
    const beforeEmployee = await capabilities(users.employee.client);
    sql(historicalGrantFixture(users.account) + historicalGrantFixture(users.employee));
    ok(await provider.auth.admin.updateUserById(users.employee.id, { user_metadata: { app_role: 'system_admin', can_manage_roles: true } }), 'user-editable provider metadata spoof fixture');
    assert.deepEqual(await capabilities(users.account.client), beforeAccount, 'Account ignores obsolete global/check-in/payroll/vault grants');
    assert.deepEqual(await capabilities(users.employee.client), beforeEmployee, 'Employee ignores obsolete grants and user-editable provider metadata');
    const otherCapabilities = await capabilities(accountOther.client);
    assert.deepEqual({ ...beforeAccount, person_id: null }, { ...otherCapabilities, person_id: null }, 'Account users with different names and historical grants have an identical capability set');
    for (const user of [users.account, users.employee]) {
      await denied(user.client, 'decide_leave_with_balance', { p_request_id: outsidePending.id, p_status: 'Approved' });
      await denied(user.client, 'list_employee_check_in_workspace');
      await denied(user.client, 'get_subscription_credential', { p_subscription_id: subscription.subscription_id });
      await denied(user.client, 'patch_subscription_v1', { p_subscription_id: subscription.subscription_id, p_expected_version: subscription.version, p_patch: { subscription_status: 'active' } });
      await denied(user.client, 'commit_payroll_balance_import', { p_batch_id: comparison.batchId, p_expected_version: comparison.version });
    }
    await denied(provider, 'stage_payroll_balance_import', { p_actor_user_id: users.employee.id, p_source_digest: parsed.sourceDigest, p_files: parsed.files, p_rows: parsed.rows });
    const employeeRows = ok(await users.employee.client.rpc('list_leave_workspace_requests'), 'employee still self-scoped despite historical global grant');
    assert.equal(employeeRows.some(row => row.id === outsidePending.id), false, 'Historical global grant does not leak unrelated pending private leave');
    assert.equal(ok(await users.employee.client.rpc('can_download_leave_request_attachment', { p_attachment_id: outsidePending.attachment }), 'employee evidence authorization only'), false, 'Historical leave-read grant does not grant other evidence access');
  });
  const newReportPending = leaveFixture(users.employee, 'submitted', { dateOffset: 140 });
  sql(newReportPending.sql);
  await check('Manager historical globals cannot widen reporting authority', async () => {
    sql(historicalGrantFixture(users.manager));
    const expected = expectedCapabilities('manager', users.manager.id, { management: true, vault: true });
    assert.deepEqual(await capabilities(users.manager.client), expected, 'Only the two legitimate independent Manager subscription grants elevate capability');
    await denied(users.manager.client, 'decide_leave_with_balance', { p_request_id: outsidePending.id, p_status: 'Approved' });
    const rows = ok(await users.manager.client.rpc('list_leave_workspace_requests'), 'Manager scope with stale global grant');
    assert.equal(rows.some(row => row.id === outsidePending.id), false, 'Manager obsolete global leave grant cannot widen private read scope');
    assert.equal(rows.find(row => row.id === newReportPending.id)?.can_decide, true, 'Manager retains current reporting authority');
    assert.equal(ok(await users.manager.client.rpc('can_import_payroll_balances'), 'Manager with obsolete payroll grant'), false, 'Manager role is not a payroll importer');
    assert.equal(ok(await users.manager.client.rpc('get_subscription_credential', { p_subscription_id: subscription.subscription_id }), 'granted Manager vault boundary').length, 1, 'Active linked Manager retains a real independent vault grant');
  });
  await check('Manager demotion denies existing JWT despite retained personal grants and reroutes pending work', async () => {
    const grants = grantCounts(users.manager);
    const oldToken = users.manager.token;
    await setRole(users.manager, 'employee');
    assert.equal((await users.manager.client.auth.getSession()).data.session.access_token, oldToken, 'Demotion is tested with the identical existing GoTrue JWT, not a refreshed login');
    assert.deepEqual(await capabilities(users.manager.client), expectedCapabilities('employee', users.manager.id), 'Demotion immediately removes role and grant-derived powers');
    assert.deepEqual(await capabilities(p0.client, users.manager.id), expectedCapabilities('employee', users.manager.id), 'P0 target preview immediately reflects demotion');
    await denied(users.manager.client, 'decide_leave_with_balance', { p_request_id: newReportPending.id, p_status: 'Approved' });
    await denied(users.manager.client, 'get_subscription_credential', { p_subscription_id: subscription.subscription_id });
    await denied(users.manager.client, 'patch_subscription_v1', { p_subscription_id: subscription.subscription_id, p_expected_version: subscription.version, p_patch: { subscription_status: 'active' } });
    await denied(provider, 'stage_payroll_balance_import', { p_actor_user_id: users.manager.id, p_source_digest: parsed.sourceDigest, p_files: parsed.files, p_rows: parsed.rows });
    assert.equal(grants, grantCounts(users.manager), 'Demotion preserves historical/configuration grant rows');
    assert.equal(sql(`select count(*) from private.leave_request_reviewer_assignments where leave_request_id='${newReportPending.id}' and reviewer_user_id='${users.manager.id}';`), '0', 'Still-pending work is rerouted away from the demoted Manager');
  });
  await check('Admin demotion to Account then Employee denies existing JWT and stale grants', async () => {
    sql(historicalGrantFixture(users.admin));
    const grants = grantCounts(users.admin);
    const oldToken = users.admin.token;
    await setRole(users.admin, 'account');
    assert.deepEqual(await capabilities(users.admin.client), expectedCapabilities('account', users.admin.id), 'Demoted Admin receives exactly Account policy');
    await denied(users.admin.client, 'decide_leave_with_balance', { p_request_id: outsidePending.id, p_status: 'Approved' });
    await denied(users.admin.client, 'get_subscription_credential', { p_subscription_id: subscription.subscription_id });
    await denied(users.admin.client, 'set_employee_annual_leave_balance', { p_person_id: users.employee.id, p_hours: 999, p_as_of: asOf, p_is_example: false });
    await denied(users.admin.client, 'commit_payroll_balance_import', { p_batch_id: comparison.batchId, p_expected_version: comparison.version });
    await setRole(users.admin, 'employee');
    assert.deepEqual(await capabilities(users.admin.client), expectedCapabilities('employee', users.admin.id), 'Further demotion receives exactly Employee policy');
    await denied(provider, 'stage_payroll_balance_import', { p_actor_user_id: users.admin.id, p_source_digest: parsed.sourceDigest, p_files: parsed.files, p_rows: parsed.rows });
    assert.deepEqual(ok(await users.admin.client.rpc('get_payroll_balance_import_workspace'), 'demoted payroll workspace'), { canImport: false, canManageAccess: false }, 'Demoted Employee gets a closed empty payroll workspace, not retained importer data');
    assert.equal((await users.admin.client.auth.getSession()).data.session.access_token, oldToken, 'Both demotions use the identical actual provider JWT');
    assert.equal(grants, grantCounts(users.admin), 'Both demotions retain stale grant history rather than deleting it');
  });
  await check('Account demotion removes global leave/evidence and payroll comparison with the existing JWT', async () => {
    const grants = grantCounts(users.account);
    await setRole(users.account, 'employee');
    assert.deepEqual(await capabilities(users.account.client), expectedCapabilities('employee', users.account.id), 'Account demotion removes global read and comparison capabilities');
    const rows = ok(await users.account.client.rpc('list_leave_workspace_requests'), 'demoted Account self leave');
    assert.equal(rows.some(row => row.id === outsidePending.id), false, 'Demoted Account cannot retain its previous global private leave read');
    assert.equal(ok(await users.account.client.rpc('can_download_leave_request_attachment', { p_attachment_id: outsidePending.attachment }), 'demoted evidence authorization'), false, 'Demoted Account loses previous global evidence authorization');
    await denied(users.account.client, 'get_payroll_balance_import_batch', { p_batch_id: comparison.batchId });
    await denied(provider, 'stage_payroll_balance_import', { p_actor_user_id: users.account.id, p_source_digest: parsed.sourceDigest, p_files: parsed.files, p_rows: parsed.rows });
    assert.equal(grants, grantCounts(users.account), 'Historical grants survive demotion without restoring authority');
  });
  for (const role of ['employee', 'manager', 'account', 'admin']) {
    const user = await account(`state-${role}`);
    await setRole(user, role);
    sql(historicalGrantFixture(user));
    const activeExpected = expectedCapabilities(role, user.id, { management: role === 'manager', vault: role === 'manager' });
    const states = {
      disabled: [`update public.profiles set account_status='disabled',disabled_at=now() where id='${user.id}';`, `update public.profiles set account_status='active',disabled_at=null where id='${user.id}';`],
      archived: [`update public.internal_org_people set is_active=false where id='${user.id}';`, `update public.internal_org_people set is_active=true where id='${user.id}';`],
      unlinked: [`update public.internal_org_people set auth_user_id=null where id='${user.id}';`, `update public.internal_org_people set auth_user_id='${user.id}' where id='${user.id}';`],
      'credential-epoch-stale': [`update public.profiles set credentials_valid_after=to_timestamp(${user.iat})+interval '1 second' where id='${user.id}';`, `update public.profiles set credentials_valid_after=now()-interval '1 day' where id='${user.id}';`],
    };
    for (const [state, [enter, restore]] of Object.entries(states)) {
      await check(`${role} ${state} rejects real existing JWT despite personal grants`, async () => {
        sql(enter);
        try {
        await denied(user.client, 'get_portal_role_capabilities', { p_person_id: null });
        await denied(user.client, 'list_leave_workspace_requests');
        await denied(user.client, 'list_leave_workspace_attachments');
        await denied(user.client, 'decide_leave_with_balance', { p_request_id: outsidePending.id, p_status: 'Approved' });
        await denied(user.client, 'get_subscription_credential', { p_subscription_id: subscription.subscription_id });
        await denied(user.client, 'patch_subscription_v1', { p_subscription_id: subscription.subscription_id, p_expected_version: subscription.version, p_patch: { subscription_status: 'active' } });
        assert.equal(ok(await user.client.rpc('can_download_leave_request_attachment', { p_attachment_id: outsidePending.attachment }), 'invalid-state download authorization'), false, 'Invalid account/link/session cannot retain evidence authorization');
        for (const rpc of ['can_manage_portal_accounts', 'can_manage_subscription_credentials', 'can_manage_subscriptions', 'can_import_payroll_balances', 'can_review_leave_workspace']) assert.equal(ok(await user.client.rpc(rpc), 'invalid-state capability'), false, `${rpc} denies invalid role/account/link/session`);
        if (state !== 'credential-epoch-stale') {
          await denied(p0.client, 'get_portal_role_capabilities', { p_person_id: user.id });
          await denied(provider, 'stage_payroll_balance_import', { p_actor_user_id: user.id, p_source_digest: parsed.sourceDigest, p_files: parsed.files, p_rows: parsed.rows });
        } else {
          assert.deepEqual(await capabilities(p0.client, user.id), activeExpected, 'P0 preview is current target policy, not impersonation of the target stale JWT');
        }
        assert.equal(sql(`select count(*) from auth.sessions where id='${user.sessionId}' and user_id='${user.id}';`), '1', 'The actual provider session still exists, so denials are application reauthorization rather than deleted-fixture absence');
        } finally {
          sql(restore);
        }
        assert.deepEqual(await capabilities(user.client), activeExpected, 'Fixture restoration verifies active same-role capability, not permanently broken setup');
      });
    }
  }
  await check('unknown legacy hr role fails closed without deleting historical personal grants', async () => {
    const legacy = await account('legacy-role');
    sql(historicalGrantFixture(legacy));
    sql(`update public.profiles set app_role='hr' where id='${legacy.id}';`);
    await denied(legacy.client, 'get_portal_role_capabilities', { p_person_id: null });
    await denied(p0.client, 'get_portal_role_capabilities', { p_person_id: legacy.id });
    await denied(legacy.client, 'get_subscription_credential', { p_subscription_id: subscription.subscription_id });
    await denied(legacy.client, 'decide_leave_with_balance', { p_request_id: outsidePending.id, p_status: 'Approved' });
    await denied(provider, 'stage_payroll_balance_import', { p_actor_user_id: legacy.id, p_source_digest: parsed.sourceDigest, p_files: parsed.files, p_rows: parsed.rows });
    assert.equal(ok(await legacy.client.rpc('can_manage_portal_accounts'), 'legacy role account capability'), false, 'Legacy hr cannot keep operational authority');
  });
  await check('P0/Admin daily leave administration remains real and P0 cannot self-approve', async () => {
    await setRole(users.admin, 'admin');
    const decided = ok(await users.admin.client.rpc('decide_leave_with_balance', { p_request_id: outsidePending.id, p_status: 'Approved', p_manager_note: 'Synthetic Admin global decision' }), 'Admin global leave mutation');
    assert.equal(decided[0].id, outsidePending.id, 'Admin retains real global operational decisions');
    assert.equal(sql(`select status from public.leave_requests where id='${outsidePending.id}';`), 'approved', 'Exact Admin global decision is read back');
    const ownP0 = leaveFixture(protectedP0, 'submitted', { dateOffset: 145 });
    sql(ownP0.sql);
    await denied(protectedP0.client, 'decide_leave_with_balance', { p_request_id: ownP0.id, p_status: 'Approved' });
    const other = leaveFixture(outside, 'submitted', { dateOffset: 146 });
    sql(other.sql);
    ok(await p0.client.rpc('decide_leave_with_balance', { p_request_id: other.id, p_status: 'Approved' }), 'standalone P0 operational leave decision');
    assert.equal(sql(`select status from public.leave_requests where id='${other.id}';`), 'approved', 'Standalone P0 operational decision is durable');
  });
  await check('role changes retain onboarding-send fence without notifications', async () => {
    const target = await account('onboarding-guard-target');
    sql(`update private.employee_onboarding_credentials set status='claimed',claim_token='${randomUUID()}',claim_expires_at=now()+interval '5 minutes' where person_id='${target.id}';`);
    try {
      await denied(p0.client, 'update_employee_directory_role', { p_person_id: target.id, p_role: 'admin', p_expected_role: 'employee' }, ['55000']);
      assert.equal(sql(`select app_role from public.profiles where id='${target.id}';`), 'employee', 'Onboarding send fence prevents role update');
    } finally {
      sql(`update private.employee_onboarding_credentials set status='scheduled',claim_token=null,claim_expires_at=null where person_id='${target.id}';`);
    }
    await setRole(target, 'admin');
  });
  await check('role changes retain aged durable pending-reset fence without provider password writes', async () => {
    const target = await account('reset-guard-target');
    const version = Number(sql(`select account_version from public.profiles where id='${target.id}';`));
    const reset = ok(await users.admin.client.rpc('begin_portal_password_reset', { p_person_id: target.id, p_auth_user_id: target.id, p_expected_account_version: version }), 'Admin begin reset preflight only')[0];
    assert.equal(sql(`select status from private.portal_password_reset_claims where auth_user_id='${target.id}';`), 'pending', 'Actual Admin preflight creates a durable reset claim');
    try {
      sql(`update private.portal_password_reset_claims set claimed_at=now()-interval '1 hour' where auth_user_id='${target.id}';`);
      await denied(p0.client, 'update_employee_directory_role', { p_person_id: target.id, p_role: 'admin', p_expected_role: 'employee' }, ['55000', '40001']);
      assert.equal(sql(`select app_role from public.profiles where id='${target.id}';`), 'employee', 'Aged pending reset still blocks a conflicting role write');
    } finally {
      assert.equal(ok(await users.admin.client.rpc('cancel_portal_password_reset', { p_auth_user_id: target.id, p_reset_token: reset.reset_token }), 'explicit reset cancellation'), true, 'Actual Admin can explicitly cancel its pending preflight');
      assert.equal(sql(`select status from private.portal_password_reset_claims where auth_user_id='${target.id}';`), 'cancelled', 'Exact reset cancellation is read back');
    }
    await setRole(target, 'admin');
  });
  await check('standalone P0 disabled/stale JWT loses even preview, then restores equivalent unchanged authority', async () => {
    const target = accountOther.id;
    sql(`update public.profiles set account_status='disabled',disabled_at=now() where id='${p0.id}';`);
    await denied(p0.client, 'get_portal_role_capabilities', { p_person_id: null });
    await denied(p0.client, 'get_portal_role_capabilities', { p_person_id: target });
    sql(`update public.profiles set account_status='active',disabled_at=null where id='${p0.id}';`);
    sql(`update public.profiles set credentials_valid_after=to_timestamp(${p0.iat})+interval '1 second' where id='${p0.id}';`);
    await denied(p0.client, 'get_portal_role_capabilities', { p_person_id: null });
    await denied(p0.client, 'get_portal_role_capabilities', { p_person_id: target });
    await denied(p0.client, 'update_employee_directory_role', { p_person_id: target, p_role: 'admin', p_expected_role: 'account' });
    sql(`update public.profiles set credentials_valid_after=now()-interval '1 day' where id='${p0.id}';`);
    assert.deepEqual(await capabilities(p0.client), p0Expected, 'Standalone P0 reauthorization remains intact without an employee link');
    const finalAuth = ok(await provider.auth.admin.getUserById(p0.id), 'P0 final provider readback').user;
    for (const field of ['id', 'email', 'created_at', 'app_metadata', 'user_metadata', 'identities']) assert.deepEqual(finalAuth[field], p0AuthSnapshot[field], `P0 provider identity ${field} remains unchanged`);
    assert.equal(sql(`select app_role='system_admin' and login_name is not null and account_status='active' from public.profiles where id='${p0.id}';`), 't', 'Standalone P0 login and role remain unchanged');
    assert.equal(sql(`select count(*) from public.internal_org_people where auth_user_id='${p0.id}';`), '0', 'Standalone P0 remains standalone');
  });
  await check('anonymous/service callers cannot acquire canonical user/P0 capabilities or account role writes', async () => {
    const anonymous = createClient(base, anonKey, options);
    await denied(anonymous, 'get_portal_role_capabilities', { p_person_id: null });
    await denied(anonymous, 'update_employee_directory_role', { p_person_id: accountOther.id, p_role: 'admin', p_expected_role: 'account' });
    await denied(provider, 'get_portal_role_capabilities', { p_person_id: null });
    await denied(provider, 'update_employee_directory_role', { p_person_id: accountOther.id, p_role: 'admin', p_expected_role: 'account' });
    await denied(users.admin.client, 'claim_leave_notification_outbox', { p_request_id: null, p_limit: 1 });
    assert.deepEqual(await capabilities(accountOther.client), expectedCapabilities('account', accountOther.id), 'Service/operator boundaries cannot promote the ordinary role');
  });
  await check('P0 stale-role CAS returns conflict without changing the exact target', async () => {
    const target = await account('stale-cas-target');
    const started = performance.now();
    const conflict = await p0.client.rpc('update_employee_directory_role', { p_person_id: target.id, p_role: 'admin', p_expected_role: 'manager' });
    assert.equal(conflict.error?.code, 'PT409', 'Semantic role CAS uses documented PTxyz, not retried transactional 40001');
    assert.equal(conflict.status, 409, 'Stale role CAS returns exact HTTP 409, never a gateway/server outage');
    assert.equal(conflict.error.message, 'Role has changed. Refresh and try again.', 'Semantic CAS has the exact actionable database message');
    assert.ok(performance.now() - started < 5000, 'Semantic stale CAS denial finishes within five seconds without provider retry');
    assert.equal(sql(`select app_role from public.profiles where id='${target.id}';`), 'employee', 'Rejected stale CAS does not change the exact role');
    assert.equal(sql(`select count(*) from private.employee_directory_audit_events where person_id='${target.id}' and changed_fields=array['app_role']::text[];`), '0', 'Rejected stale CAS creates no role audit');
  });
  await check('P0 concurrent role CAS has one winner and one conflict with one real actor audit', async () => {
    const target = await account('concurrent-cas-target');
    const started = performance.now();
    const results = await Promise.all(['admin', 'account'].map(role => p0.client.rpc('update_employee_directory_role', { p_person_id: target.id, p_role: role, p_expected_role: 'employee' })));
    assert.equal(results.filter(result => !result.error).length, 1, 'Exactly one real concurrent role update wins');
    const winningRole = results.find(result => !result.error).data;
    assert.equal(sql(`select app_role from public.profiles where id='${target.id}';`), winningRole, 'Concurrent winner is durable');
    assert.equal(sql(`select count(*) from private.employee_directory_audit_events where person_id='${target.id}' and actor_user_id='${p0.id}' and changed_fields=array['app_role']::text[];`), '1', 'Concurrent role write is audited once with the actual P0 actor');
    assert.equal(results.filter(result => result.error?.code === 'PT409' && result.status === 409).length, 1, 'Exactly one real concurrent role update returns documented PT409/HTTP 409, not a transport outage');
    assert.equal(results.find(result => result.error).error.message, 'Role has changed. Refresh and try again.', 'Concurrent loser receives the same exact semantic CAS message');
    assert.ok(performance.now() - started < 5000, 'Concurrent role CAS winner and denial finish within five seconds without provider retry');
  });
  await check('unchanged application/provider helpers, restrictive triggers and synthetic Auth sessions survive all cases', async () => {
    assert.equal(applicationFingerprint, appFingerprint(), 'Runner never replaces or relaxes any application function or trigger');
    assert.equal(providerFunctions, sql("select md5(string_agg(pg_get_functiondef(p.oid),E'\n' order by p.proname)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='auth' and p.proname in ('uid','jwt','role');"), 'GoTrue remains the sole owner of actual Auth helper definitions');
    assert.equal(Number(sql('select count(*) from auth.users;')), fixtures.length, 'Only exactly the supported synthetic provider-created users exist');
    for (const fixture of fixtures) {
      assert.equal(sql(`select count(*) from auth.sessions where id='${fixture.sessionId}' and user_id='${fixture.id}';`), '1', 'Every tested existing JWT still has its actual provider session');
    }
    assert.deepEqual(await capabilities(p0.client), p0Expected, 'P0 authority remains equivalent at suite completion');
  });
} catch (error) {
  failed = true;
  if (checks.at(-1)?.name !== activeCheck || checks.at(-1)?.status !== 'fail') {
    checks.push({ name: activeCheck, status: 'fail' });
    console.error(`FAIL ${activeCheck}: ${String(error.message).split('\n')[0].slice(0, 300)}`);
  }
} finally {
  if (gateway) { gateway.closeAllConnections(); await new Promise(resolveClose => gateway.close(resolveClose)); }
  try {
    for (const name of [...resources.containers].reverse()) {
      const labels = JSON.parse(text(['inspect', name, '--format', '{{json .Config.Labels}}']));
      assert.equal(labels[`${label}.run`], prefix, 'Cleanup only owns this exact run');
      text(['rm', '-f', '-v', name]);
    }
    if (resources.network) {
      const labels = JSON.parse(text(['network', 'inspect', prefix, '--format', '{{json .Labels}}']));
      assert.equal(labels[`${label}.run`], prefix, 'Cleanup only owns this network');
      text(['network', 'rm', prefix]);
    }
    if (resources.volume) {
      const labels = JSON.parse(text(['volume', 'inspect', volume, '--format', '{{json .Labels}}']));
      assert.equal(labels[`${label}.run`], prefix, 'Cleanup only owns this volume');
      text(['volume', 'rm', volume]);
    }
    assert.equal(text(['ps', '-aq', '--filter', `label=${runLabel}`]), '', 'Exact run containers must be absent');
    assert.equal(text(['network', 'ls', '-q', '--filter', `label=${runLabel}`]), '', 'Exact run network must be absent');
    assert.equal(text(['volume', 'ls', '-q', '--filter', `label=${runLabel}`]), '', 'Exact run volume must be absent');
    for (const name of Object.values(names)) assert.notEqual(docker(['inspect', name], undefined, true).status, 0, 'Exact container name must be absent');
    assert.notEqual(docker(['network', 'inspect', prefix], undefined, true).status, 0, 'Exact network name must be absent');
    assert.notEqual(docker(['volume', 'inspect', volume], undefined, true).status, 0, 'Exact volume name must be absent');
    console.log('CLEANUP verified exact run containers/network/volume absent; dedicated VM unchanged');
  } catch (error) {
    failed = true;
    checks.push({ name: 'exact resource cleanup', status: 'fail' });
    console.error(`FAIL exact resource cleanup: ${String(error.message).split('\n')[0].slice(0, 300)}`);
  }
  console.log(`ASSERTION_SUMMARY ${JSON.stringify({ schema: mode, migrations: migrations.length, migrationSha256: manifest, complete: !failed, passed: checks.filter(item => item.status === 'pass').length, failed: checks.filter(item => item.status === 'fail').length, checks })}`);
  console.log('NOT VERIFIED Storage HTTP file-download/upload delivery; Storage bootstrap is synthetic table shape only; hosted providers/configuration, production staff, outbound notifications');
  process.exitCode = failed ? 1 : 0;
}
