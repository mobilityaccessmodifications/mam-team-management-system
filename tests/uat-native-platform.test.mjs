import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../deploy/uat/native-platform/', import.meta.url);
const read = (name) => readFileSync(new URL(name, root), 'utf8');

test('native platform source is three bounded SQL phases, not an Auth installer', () => {
  assert.deepEqual(readdirSync(root).filter((name) => name.endsWith('.sql')).sort(), [
    '001-pre-auth.sql', '002-post-auth-grants.sql', '003-readback.sql',
  ]);
  const source = read('001-pre-auth.sql');
  assert.equal((source.match(/^CREATE ROLE /gm) ?? []).length, 6);
  assert.match(source, /^BEGIN;$/m);
  assert.match(source, /^COMMIT;$/m);
  assert.doesNotMatch(source, /(?:CREATE|ALTER|DROP)\s+(?:TABLE|FUNCTION)\s+auth\./i);
  assert.doesNotMatch(source, /IF NOT EXISTS|CREATE PUBLICATION|CREATE (?:TABLE|FUNCTION) (?:public|private)\./i);
  assert.match(source, /CREATE EXTENSION pgcrypto WITH SCHEMA extensions/);
  assert.match(source, /WITH ADMIN FALSE, INHERIT FALSE, SET TRUE/);
});

test('database passwords enter only through two named environment variables after target guards', () => {
  const source = read('001-pre-auth.sql');
  const imports = [...source.matchAll(/^\\getenv (\w+) (\w+)$/gm)];
  assert.deepEqual(imports.map((match) => match[2]), ['MAM_UAT_AUTH_DB_PASSWORD', 'MAM_UAT_REST_DB_PASSWORD']);
  assert.ok(source.indexOf('$guard$;') < imports[0].index);
  assert.match(source, /\^\[A-Za-z0-9_-\]\{43,128\}\$/);
  assert.match(source, /:'_uat_auth_password' <> :'_uat_rest_password'/);
  for (const [, variable] of imports) {
    assert.match(source, new RegExp(`PASSWORD :'${variable}'`));
    assert.match(source, new RegExp(`^\\\\unset ${variable}$`, 'm'));
  }
  assert.doesNotMatch(source, /\\(?:echo|!|copy)\b/i);
});

test('post-Auth phase grants only schema usage and three provider helpers', () => {
  const source = read('002-post-auth-grants.sql');
  assert.deepEqual(source.match(/^GRANT .*$/gm), [
    'GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;',
    'GRANT EXECUTE ON FUNCTION auth.uid(), auth.jwt(), auth.role() TO anon, authenticated, service_role;',
  ]);
  assert.doesNotMatch(source, /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE)\s+(?:TABLE|FUNCTION|auth\.)/i);
  assert.match(source, /FROM auth\.schema_migrations/);
  assert.match(source, /Initial Auth business tables must be empty/);
  assert.match(source, /pg_get_userbyid\(p\.proowner\) = 'supabase_auth_admin'/);
});

test('readback is read-only metadata, counts and helper hashes without secret projections', () => {
  const source = read('003-readback.sql');
  assert.match(source, /^BEGIN READ ONLY;$/m);
  assert.match(source, /statement_timeout = '10s'/);
  assert.match(source, /'passwordConfigured', EXISTS \(SELECT 1 FROM pg_authid a WHERE a\.oid = r\.oid AND a\.rolpassword IS NOT NULL\)/);
  assert.match(source, /sha256\(convert_to\(pg_get_functiondef/);
  assert.doesNotMatch(source, /SELECT\s+\*|rolconfig|proconfig|current_setting\('request\.jwt|\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|COPY)\b/i);
  assert.equal((source.match(/rolpassword/g) ?? []).length, 1);
});
