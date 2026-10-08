import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync, fork } from 'node:child_process';
import { once } from 'node:events';
import yaml from 'js-yaml';
import { runRecovery } from '../scripts/recover-background-jobs.mjs';

const expectedJobs = [
  'leave-notifications', 'check-in-reminders', 'new-starter-day-one',
  'onboarding-credentials', 'scheduled-offboarding', 'leave-priority-reminders',
];
const workflow = () => yaml.load(readFileSync('.github/workflows/background-recovery.yml', 'utf8'));
const quiet = { log() {}, error() {} };
const invoke = (args, failed = false) => spawnSync(process.execPath, [
  '--import', './tests/fixtures/background-recovery-fetch.mjs',
  'scripts/recover-background-jobs.mjs', ...args,
], {
  encoding: 'utf8', timeout: 5_000,
  env: { PATH: process.env.PATH, MAM_PEOPLE_HUB_CRON_SECRET: 'synthetic-cli-only', MAM_SYNTHETIC_FAILURE: String(failed) },
});

test('one waiting recovery job does not hold a workflow-wide concurrency slot', () => {
  const spec = workflow();
  assert.equal(spec.concurrency, undefined);
  const job = spec.jobs.recover;
  assert.equal(job.needs, undefined);
  assert.deepEqual(job.strategy.matrix.job, expectedJobs);
  assert.equal(job.strategy['max-parallel'], 6);
  assert.equal(job.concurrency.group, 'people-hub-background-recovery-${{ matrix.job }}');
});

test('a failed or timed-out matrix worker does not cancel unrelated workers', () => {
  const job = workflow().jobs.recover;
  assert.equal(job.strategy?.['fail-fast'], false);
  assert.equal(job.concurrency?.['cancel-in-progress'], false);
  assert.equal(job['timeout-minutes'], 20);
  assert.equal(job['continue-on-error'], undefined);
});

test('the same business shares a lock across scheduled and manual runs', () => {
  const job = workflow().jobs.recover;
  const group = job.concurrency?.group;
  assert.equal(group, 'people-hub-background-recovery-${{ matrix.job }}');
  const keys = expectedJobs.map(name => group.replace('${{ matrix.job }}', name));
  assert.equal(new Set(keys).size, 6);
  assert.equal(group.includes('run_id'), false);
  assert.equal(group.includes('event_name'), false);
  assert.equal(job.concurrency['cancel-in-progress'], false);
});

test('each isolated runner calls only its selected business once', async () => {
  for (const selected of expectedJobs) {
    const calls = [];
    const ok = await runRecovery('synthetic-only', async (url, options) => {
      calls.push(new URL(url).searchParams.get('job'));
      assert.equal(new URL(url).origin, 'https://mam-team-management-system-ten.vercel.app');
      assert.equal(options.redirect, 'error');
      assert.equal(options.cache, 'no-store');
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json({ ok: true });
    }, quiet, selected);
    assert.equal(ok, true);
    assert.deepEqual(calls, [selected]);
  }
});

test('unsupported selected jobs fail closed before any request', async () => {
  let calls = 0;
  for (const name of ['', '__proto__', 'constructor', 'leave-accrual', 'https://attacker.example', ['onboarding-credentials']]) {
    await assert.rejects(runRecovery('synthetic-only', async () => { calls++; }, quiet, name), /supported recovery worker/);
  }
  assert.equal(calls, 0);
});

test('matrix execution retains main-only code, environment protection and UTC cadence', () => {
  const spec = workflow();
  assert.deepEqual(spec.on.schedule, [{ cron: '7,22,37,52 * * * *' }]);
  assert.ok(Object.hasOwn(spec.on, 'workflow_dispatch'));
  assert.equal(Object.hasOwn(spec.on, 'pull_request'), false);
  assert.deepEqual(spec.permissions, { contents: 'read' });
  const job = spec.jobs.recover;
  assert.equal(job.if, "github.ref == 'refs/heads/main'");
  assert.equal(job.environment, 'people-hub-production');
  assert.deepEqual(job.steps[0].with, { ref: 'main', 'persist-credentials': false });
  const step = job.steps.find(item => item.run);
  assert.equal(step.env.MAM_RECOVERY_JOB, '${{ matrix.job }}');
  assert.equal(step.env.MAM_PEOPLE_HUB_CRON_SECRET, '${{ secrets.MAM_PEOPLE_HUB_CRON_SECRET }}');
  assert.equal(step.run, 'node scripts/recover-background-jobs.mjs "$MAM_RECOVERY_JOB"');
});

test('the actual CLI selects exactly one worker with no implicit all-worker fallback', () => {
  for (const job of expectedJobs) {
    const result = invoke([job]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.match(/SYNTHETIC_REQUEST:.*/g), [`SYNTHETIC_REQUEST:${job}`]);
    assert.equal(result.stdout.includes('SYNTHETIC_PRIVATE_DETAIL'), false);
  }
  for (const args of [[], ['unknown'], ['onboarding-credentials', 'check-in-reminders']]) {
    const result = invoke(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.includes('SYNTHETIC_REQUEST:'), false);
    assert.match(result.stderr, /Select one supported recovery worker/);
  }
});

test('a failed CLI worker returns failure without retry or private diagnostics', () => {
  const result = invoke(['onboarding-credentials'], true);
  assert.equal(result.status, 1);
  assert.deepEqual(result.stdout.match(/SYNTHETIC_REQUEST:.*/g), ['SYNTHETIC_REQUEST:onboarding-credentials']);
  assert.equal((result.stdout + result.stderr).includes('SYNTHETIC_PRIVATE_DETAIL'), false);
  assert.equal((result.stdout + result.stderr).includes('synthetic-cli-only'), false);
  assert.match(result.stderr, /onboarding-credentials: dispatcher unavailable/);
});

test('five actual runner processes finish while an unrelated runner is held', { timeout: 5_000 }, async t => {
  const children = expectedJobs.map(job => {
    const child = fork('scripts/recover-background-jobs.mjs', [job], {
      execArgv: ['--import', './tests/fixtures/background-recovery-fetch.mjs'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { PATH: process.env.PATH, MAM_PEOPLE_HUB_CRON_SECRET: 'synthetic-cli-only',
        MAM_SYNTHETIC_HOLD: String(job === 'onboarding-credentials') },
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    return { job, child, done: once(child, 'exit'), output: () => output };
  });
  const held = children.find(item => item.job === 'onboarding-credentials');
  assert.deepEqual(await once(held.child, 'message'), ['held', undefined]);
  for (const result of await Promise.all(children.filter(item => item !== held).map(item => item.done))) {
    assert.deepEqual(result, [0, null]);
  }
  assert.equal(held.child.exitCode, null);
  held.child.send('release');
  assert.deepEqual(await held.done, [0, null]);
  for (const item of children) assert.deepEqual(item.output().match(/SYNTHETIC_REQUEST:.*/g), [`SYNTHETIC_REQUEST:${item.job}`]);
});

test('an actual timeout exits only its runner and makes no implicit retry', { timeout: 5_000 }, async () => {
  const timed = fork('scripts/recover-background-jobs.mjs', ['onboarding-credentials'], {
    execArgv: ['--import', './tests/fixtures/background-recovery-fetch.mjs'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH, MAM_PEOPLE_HUB_CRON_SECRET: 'synthetic-cli-only', MAM_SYNTHETIC_TIMEOUT: 'true' },
  });
  let output = '';
  timed.stdout.on('data', data => { output += data; });
  timed.stderr.on('data', data => { output += data; });
  const done = once(timed, 'exit');
  try {
    assert.equal(invoke(['check-in-reminders']).status, 0);
    assert.deepEqual(await done, [1, null]);
    assert.deepEqual(output.match(/SYNTHETIC_REQUEST:.*/g), ['SYNTHETIC_REQUEST:onboarding-credentials']);
    assert.match(output, /dispatcher unavailable/);
    assert.equal(output.includes('synthetic-cli-only'), false);
  } finally { if (timed.exitCode === null) timed.kill(); }
});
