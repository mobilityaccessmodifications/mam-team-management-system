import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { homedir } from 'node:os';
import { testPurgeConcurrency } from './confirmed-test-purge-concurrency.mjs';
import { testDeliveredHistoryMigration } from './confirmed-test-purge-delivered-migration.mjs';
import { testDeliveredHistoryConcurrency } from './confirmed-test-purge-delivered-concurrency.mjs';
import { testDeliveredHistoryProducer } from './confirmed-test-purge-delivered-producer.mjs';
const scratch = process.env.MAM_TEST_SCRATCH_DIR ?? path.join(homedir(), '.hermes/profiles/mam/cache/scratch');
const socket = mkdtempSync(path.join(scratch, 'purge-pg-'));
const env = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', PGPASSFILE: path.join(socket, 'no-password-file'), PGSERVICEFILE: '/dev/null' };
function run(binary, args, input) {
  const r = spawnSync(binary, args, { env, input, encoding: 'utf8' });
  if (r.status !== 0 || r.error) throw new Error(r.stdout + (r.stderr || r.error?.message));
  return r.stdout;
}
const args = ['-X', '-h', socket, '-p', '55441', '-U', 'postgres', '-d', 'mam_test_purge', '-v', 'ON_ERROR_STOP=1'];
let started = false;
try {
  run('initdb', ['-D', path.join(socket, 'data'), '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale']);
  run('pg_ctl', ['-D', path.join(socket, 'data'), '-l', path.join(socket, 'postgres.log'), '-o', `-k ${socket} -p 55441 -c listen_addresses='' -c unix_socket_permissions=0700`, '-w', 'start']);
  started = true;
  run('createdb', ['-h', socket, '-p', '55441', '-U', 'postgres', 'mam_test_purge']);
  run('psql', args, readFileSync('tests/migrations/0001-supabase-platform.sql', 'utf8'));
  const migrations = readdirSync('supabase/migrations').filter(f => f.endsWith('.sql')).sort();
  for (const file of migrations) {
    if(file==='20261001130000_confirmed_test_identity_cleanup.sql') run('psql',args,"alter default privileges in schema public, private grant execute on functions to anon, authenticated, service_role; alter default privileges in schema private grant all on tables to anon, authenticated, service_role;");
    if (file === '20261001140000_confirmed_test_purge_delivered_leave_history.sql' && process.argv.includes('--migration-guards')) testDeliveredHistoryMigration(args, env, readFileSync(path.join('supabase/migrations', file), 'utf8'));
    run('psql', args, readFileSync(path.join('supabase/migrations', file), 'utf8'));
  }
  console.log(`PASS: full disposable replay (${migrations.length} migrations)`);
  run('psql',args,readFileSync('tests/migrations/effective-contract.sql','utf8'));
  console.log('PASS: effective schema/RLS/ACL contract');
  for(const regression of process.argv.slice(2).filter(a=>!['--concurrency','--migration-guards','--delivered-concurrency','--delivered-producer'].includes(a))) {
    console.log(run('psql', [...args, '-f', regression]));
    console.log(`PASS: full-schema ${regression}`);
  }
  if(process.argv.includes('--delivered-producer')) await testDeliveredHistoryProducer(args,env);
  if(process.argv.includes('--concurrency')) await testPurgeConcurrency(args,env);
  if(process.argv.includes('--delivered-concurrency')) await testDeliveredHistoryConcurrency(args,env);
} finally {
  if (started) run('pg_ctl', ['-D', path.join(socket, 'data'), '-m', 'fast', '-w', 'stop']);
  rmSync(socket, { recursive: true, force: true });
}
