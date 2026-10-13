import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import yaml from 'js-yaml';

const workflow = yaml.load(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
const callers = [
  ['full-migration-replay-and-openclaw', 'runuser -u postgres -- node scripts/test-sql.mjs'],
  ['annual-leave-all-submitters', 'runuser -u postgres -- node tests/run-annual-leave-suite.mjs'],
];

for (const [name, invocation] of callers) {
  test(`${name} provisions Git before the native release rehearsal`, () => {
    const job = workflow.jobs[name];
    const runtimeIndex = job.steps.findIndex(step => step.run?.includes('apt-get install'));
    const suiteIndex = job.steps.findIndex(step => step.run === invocation);
    assert.ok(runtimeIndex >= 0 && suiteIndex > runtimeIndex);
    const runtime = job.steps[runtimeIndex].run;
    const packages = runtime.match(/^\s*apt-get install -y --no-install-recommends (.+)$/m)?.[1].split(/\s+/);
    assert.ok(packages?.includes('python3'));
    assert.ok(packages?.includes('git'), 'the release rehearsal invokes real Git under the postgres OS user');
    const gitCheck = 'runuser -u postgres -- git --version';
    const pythonCheck = 'runuser -u postgres -- python3 --version';
    assert.ok(runtime.indexOf(gitCheck) > runtime.indexOf('apt-get install'));
    assert.ok(runtime.indexOf(pythonCheck) > runtime.indexOf('apt-get install'));
    assert.equal(job.strategy['fail-fast'], false);
    assert.deepEqual(job.strategy.matrix.postgres, ['16', '17']);
    assert.equal(job.container, 'postgres:${{ matrix.postgres }}');
    assert.deepEqual(workflow.permissions, { contents: 'read' });
  });
}
