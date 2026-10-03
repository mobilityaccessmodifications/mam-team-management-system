// Owned synthetic PostgreSQL only; no credentials, URLs or real sessions.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { target, postgresEnv, command } from '../scripts/local-test-postgres.mjs';
const [socket, sourceDatabase, database = 'mam_test_operator_envelope'] = process.argv.slice(2);
function sql(statement) {
  return spawnSync('psql', [...target(socket, database), '-Atq'], {
    input: statement, env: postgresEnv, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
}
target(socket, sourceDatabase);
target(socket, database);
command('createdb', ['-h', socket, '-p', '55439', '-U', 'postgres', '--template', sourceDatabase, database]);
let setup = sql("drop function public.verify_current_payroll_operator_session(); drop function private.verify_payroll_operator_session(uuid); update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash() where singleton;");
assert.equal(setup.status, 0, setup.stderr);
const core = readFileSync('supabase/migrations/20261003090000_payroll_operator_session_proof.sql', 'utf8');
assert.ok(core.startsWith('begin;\n') && core.endsWith('commit;\n'));
const rollbackCore = core.slice(0, core.length - 'commit;\n'.length) + 'rollback;\n';
const faulty = rollbackCore.replace('do $operator_proof_after$', "alter function public.verify_current_payroll_operator_session() cost 999;\ndo $operator_proof_after$");
const result = sql(faulty);
assert.notEqual(result.status, 0, 'An undeclared new-function definition change was silently admitted');
assert.match(result.stderr, /New session-proof definition or permissions differ/);
assert.equal(sql("select to_regprocedure('public.verify_current_payroll_operator_session()') is null;").stdout.trim(), 't');
console.log('PASS: new-function full-definition drift rejects without adopting a fingerprint');
