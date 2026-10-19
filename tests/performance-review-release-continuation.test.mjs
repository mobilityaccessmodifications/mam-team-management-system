import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import test from 'node:test';

test('the continuation binds the Master-only phase to the exact completion predecessor', () => {
  const result = spawnSync('python3', ['-B', 'tests/performance-review-master-release-builder.py', 'contract'], {encoding: 'utf8', timeout: 30000});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {masterPhase: true, exactPredecessor: true});
});

for (const mode of ['apply', 'late-local']) test('completion continuation with pinned pending Master: ' + mode, () => {
  assert.ok(existsSync('scripts/deploy-performance-review-completion-with-master.py'), 'A source-bound continuation must exist without changing the old helper');
  const result = spawnSync('python3', ['-B', 'tests/performance-review-release-continuation-fixture.py', mode], {encoding: 'utf8', timeout: 60000});
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.classification, 'MODEL_CLI_INERT_MANAGEMENT_REAL_GIT');
  assert.equal(receipt.counts.mutationDispatches, mode === 'apply' ? 1 : 0);
});
