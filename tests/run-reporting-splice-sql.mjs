import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { command, postgresEnv, target } from '../scripts/local-test-postgres.mjs';

export function runReportingSpliceSql(socket, database, sourceRoot = process.cwd()) {
  const regressions = [
    'employee-removal-reporting-splice.sql',
    'reporting-splice-preflight.sql',
    'reporting-splice-delete.sql',
    'reporting-splice-safety.sql',
    'reporting-splice-graph.sql',
    'reporting-splice-consumers.sql',
    'day-one-reporting-splice-claims.sql',
    'scheduled-offboarding.sql',
  ];
  const unit = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_reporting_splice_release.py', '-v'], { cwd: sourceRoot, env: postgresEnv, stdio: 'inherit', timeout: 60000 });
  assert.equal(unit.status, 0, 'Reporting-splice release helper tests');
  const guarded = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_reporting_splice_guarded.py', '-v'], { cwd: sourceRoot, env: postgresEnv, stdio: 'inherit', timeout: 60000 });
  assert.equal(guarded.status, 0, 'Reporting-splice guarded outer adapter tests');
  for (const regression of regressions) {
    console.log(command('psql', [...target(socket, database), '-f', path.join(sourceRoot, 'tests', regression)]));
    console.log(`PASS: reporting-splice SQL ${regression}`);
  }
  const raceDatabase = `mam_test_splice_${database.replace(/^mam_test_/, '')}_race`;
  command('createdb', ['-h', socket, '-p', '55439', '-U', 'postgres', `--template=${database}`, raceDatabase]);
  const race = spawnSync(process.execPath, [path.join(sourceRoot, 'tests/run-reporting-splice-concurrency.mjs'), socket, raceDatabase], { cwd: sourceRoot, env: postgresEnv, stdio: 'inherit', timeout: 90000 });
  assert.equal(race.status, 0, 'Reporting-splice native opposing-lock regressions');
  command('dropdb', ['-h', socket, '-p', '55439', '-U', 'postgres', raceDatabase]);
  console.log(`PASS: reporting-splice ${regressions.length} SQL files, helper unit contract and native concurrency`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [socket, database, sourceRoot] = process.argv.slice(2);
  runReportingSpliceSql(socket, database, sourceRoot);
}
