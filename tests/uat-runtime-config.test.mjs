import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

for (const suite of ['uat-runtime-config.test.py', 'uat-runtime-config-policy.test.py']) {
  test(`inert UAT runtime contract: ${suite}`, { timeout: 30000 }, () => {
    const result = spawnSync('python3', ['-B', `tests/${suite}`], {
      cwd: root,
      env: {
        PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',
        LC_ALL: 'C',
        LANG: 'C',
        PYTHONDONTWRITEBYTECODE: '1',
      },
      encoding: 'utf8',
      timeout: 25000,
      maxBuffer: 1024 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
