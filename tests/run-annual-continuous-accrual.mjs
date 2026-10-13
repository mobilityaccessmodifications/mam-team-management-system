import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { startCluster, stopCluster, target, postgresEnv } from '../scripts/local-test-postgres.mjs';

const root = realpathSync(process.cwd());
const [suppliedSocket, suppliedDatabase, option] = process.argv.slice(2);
assert.ok(option === undefined || option === '--regressions', 'Only focused SQL regressions are supported');
const owned = !suppliedSocket;
const socket = suppliedSocket ?? startCluster();
const database = suppliedDatabase ?? `mam_test_annual_continuous_${process.pid}`;
function run(binary, args) {
  const result = spawnSync(binary, args, { cwd: root, env: postgresEnv, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${binary} exit ${result.status}`);
  return result.stdout;
}
try {
  console.log(`Owned synthetic socket=${socket} database=${database}`);
  if (owned) run(process.execPath, ['scripts/test-migration-replay.mjs', socket, database, '--annual-legacy-fixture']);
  const output = run('psql', [...target(socket, database), '-f', path.join(root, 'tests/annual-continuous-accrual.sql')]);
  const groups = [...output.matchAll(/^PASS (C\d{2}):/gm)].map(match => match[1]).sort();
  assert.deepEqual(groups, Array.from({ length: 19 }, (_, index) => `C${String(index + 1).padStart(2, '0')}`));
  const passed = [];
  if (option === '--regressions') {
    for (const file of ['annual-source-bank.sql', 'annual-source-adoption.sql', 'payroll-closing-contract.sql',
      'payroll-closing.sql', 'payroll-carryforward-lifecycle.sql', 'payroll-carryforward-cutoff.sql',
      'payroll-carryforward-import.sql', 'payroll-closing-security.sql', 'payroll-closing-mutation-guards.sql',
      'banked-leave-request.sql']) {
      run('psql', [...target(socket, database), '-v', 'annual_gate_current=1', '-f', path.join(root, 'tests', file)]);
      passed.push(file);
      console.log(`PASS regression ${file}`);
    }
  }
  console.log(JSON.stringify({ status: 'PASS', migrationSha256: createHash('sha256').update(readFileSync(path.join(root, 'supabase/migrations/20261013120000_annual_continuous_accrual.sql'))).digest('hex'), scenarioGroups: groups.length, groups, regressionFiles: passed.length, regressions: passed }));
} finally {
  if (owned) {
    stopCluster(socket);
    console.log(`Stopped owned synthetic PostgreSQL; retained diagnostics=${socket}`);
  }
}
