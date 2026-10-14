import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const workflow = yaml.load(readFileSync('.github/workflows/ci.yml', 'utf8'));
const replayEntry = /node\s+(?:scripts\/test-sql\.mjs|tests\/subscription-requests-browser\.mjs|tests\/run-annual-leave-suite\.mjs)/;
const installPython = /^\s*apt-get\s+install\s+[^\n]*\bpython3\b/m;

const expectedJobs = ['annual-leave-all-submitters', 'full-migration-replay-and-openclaw', 'subscription-request-browser'];

test('complete replay requires the trade-school Python release rehearsal', () => {
  const source = readFileSync('scripts/test-migration-replay.mjs', 'utf8');
  assert.match(source, /command\('python3',\s*\[path\.resolve\('tests\/run-trade-school-release\.py'\)/);
  const actualJobs = Object.entries(workflow.jobs)
    .filter(([, job]) => job.steps.some(step => replayEntry.test(step.run ?? '')))
    .map(([name]) => name).sort();
  assert.deepEqual(actualJobs, expectedJobs);
});

for (const name of expectedJobs) {
  test(`${name} installs Python before invoking complete replay`, () => {
    const job = workflow.jobs[name];
    assert.match(job.container, /^postgres:/);
    const replayIndex = job.steps.findIndex(step => replayEntry.test(step.run ?? ''));
    const installationIndex = job.steps.findIndex(step => installPython.test(step.run ?? ''));
    assert.ok(replayIndex >= 0, 'The required replay invocation must remain present');
    assert.ok(installationIndex >= 0 && installationIndex < replayIndex,
      'The PostgreSQL container must install python3 before the replay runner needs it');
  });
}

test('Requests browser CI verifies Python under the same unprivileged user as replay', () => {
  const steps = workflow.jobs['subscription-request-browser'].steps;
  const replayIndex = steps.findIndex(step => replayEntry.test(step.run ?? ''));
  const probeIndex = steps.findIndex(step => /^\s*runuser -u postgres -- python3 --version\s*$/m.test(step.run ?? ''));
  assert.ok(probeIndex >= 0 && probeIndex < replayIndex,
    'Verify python3 is available to postgres before starting the disposable replay');
});
