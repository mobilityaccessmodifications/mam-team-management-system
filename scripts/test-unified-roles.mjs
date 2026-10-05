import { spawnSync } from 'node:child_process';
import { realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCluster, stopCluster, command, postgresEnv } from './local-test-postgres.mjs';

const sourceRoot = realpathSync(process.argv[2]?.startsWith('--') ? process.cwd() : process.argv[2] ?? process.cwd());
const socket = startCluster();
let passed = false;
console.log(`Disposable PostgreSQL socket: ${socket}`);
try {
  const regressions = ['capabilities', 'policy', 'business', 'calendar', 'reset', 'control', 'delegation', 'payroll', 'security',
    'preview-freshness', 'preview-policy', 'payroll-grant-retirement']
    .map((name) => `tests/unified-role-${name}.sql`);
  const replay = spawnSync(process.execPath, [fileURLToPath(new URL('./test-migration-replay.mjs', import.meta.url)),
    socket, 'mam_test_unified_roles', ...regressions,
    'tests/confirmed-test-purge-security.sql', 'tests/confirmed-test-purge.sql'],
  { cwd: sourceRoot, env: postgresEnv, stdio: 'inherit' });
  if (replay.status !== 0) throw new Error('Full unified-role migration/SQL replay failed');
  const transition = spawnSync(process.execPath, [path.join(sourceRoot, 'tests/helpers/unified-role-transition-regressions.mjs'), socket],
    { cwd: sourceRoot, env: postgresEnv, stdio: 'inherit' });
  if (transition.status !== 0) throw new Error('Unified-role fingerprint transition PostgreSQL regressions failed');
  if (process.argv.includes('--concurrency')) {
    command('createdb', ['-h', socket, '-p', '55439', '-U', 'postgres', '--template=mam_test_unified_roles', 'mam_test_unified_role_concurrency']);
    const race = spawnSync(process.execPath, [path.join(sourceRoot, 'tests/run-unified-role-concurrency.mjs'), socket, 'mam_test_unified_role_concurrency'],
      { cwd: sourceRoot, env: postgresEnv, stdio: 'inherit' });
    if (race.status !== 0) throw new Error('Unified role/delegation PostgreSQL concurrency failed');
  }
  passed = true;
} finally {
  stopCluster(socket);
  if (passed) {
    rmSync(socket, { recursive: true });
    console.log('Stopped and removed this run\'s disposable PostgreSQL cluster');
  } else console.log(`Stopped task-owned PostgreSQL; diagnostic files: ${socket}`);
}
