import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import test from 'node:test';

test('Master inactive publisher reuses protected MAM transport and never activates or replays an unknown create', () => {
  assert.ok(existsSync('scripts/publish-performance-review-master-sync-workflow.py'), 'A fixed disabled Master publication entrypoint must exist');
  const result = spawnSync('python3', ['-B', 'tests/performance-review-master-publisher-fixture.py'], {encoding: 'utf8', timeout: 60000});
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.classification, 'MODEL_INERT_N8N_REAL_FSYNC_JOURNAL');
  assert.deepEqual(receipt.positive, {creates: 1, activations: 0, readbacks: 2});
  assert.deepEqual(receipt.unknown, {creates: 1, activations: 0});
});

test('Master public entrypoint enforces strict raw response byte caps before any workflow POST', () => {
  const result = spawnSync('python3', ['-B', 'tests/performance-review-master-publisher-fixture.py', '--byte-cap'], {encoding: 'utf8', timeout: 60000});
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.classification, 'ACTUAL_PUBLIC_ENTRY_NATIVE_API_SAFEOPENER_MEMORY_HTTP');
  const expected = {
    'wire-exact-64m': 0,
    'wire-over-64m': 2,
    'wire-over-64m-by-one': 2,
    'wire-over-page': 2,
    'raw-true': 2,
    'raw-false': 2,
    'raw-negative': 2,
    'raw-over-page': 2,
    'raw-float': 2,
    'raw-string': 2,
    'raw-list': 2,
    'raw-object': 2,
    'raw-zero': 0,
    'raw-exact-page': 0,
    'fallback-none': 0,
    'fallback-missing': 0,
    'fallback-over-page': 2,
  };
  assert.deepEqual(receipt.cases.map(row => row.case).sort(), Object.keys(expected).sort());
  for (const row of receipt.cases) {
    const success = expected[row.case] === 0;
    assert.deepEqual(
      {exit: row.exit, creates: row.creates, readbacks: row.readbacks, phase: row.phase},
      {exit: expected[row.case], creates: success ? 1 : 0, readbacks: success ? 1 : 0, phase: success ? 'STAGED_INACTIVE' : null},
      row.case,
    );
    assert.equal(row.lockExists, !success, row.case);
    assert.equal(row.stderr, success ? '' : 'HOLD_MASTER_PUBLICATION_NO_RETRY\n', row.case);
    if (success) {
      assert.equal(JSON.parse(row.stdout).active, false, row.case);
      assert.equal(JSON.parse(row.stdout).runtimeProviderVerified, false, row.case);
    } else {
      assert.equal(row.stdout, '', row.case);
    }
  }
  for (const [name, pages, bytes] of [
    ['wire-exact-64m', 8, 64 * 1024 * 1024],
    ['wire-over-64m', 9, 72 * 1024 * 1024],
    ['wire-over-64m-by-one', 9, 64 * 1024 * 1024 + 1],
    ['wire-over-page', 1, 8 * 1024 * 1024 + 1],
  ]) {
    const row = receipt.cases.find(row => row.case === name);
    assert.deepEqual([row.inventoryPages, row.inventoryWireBytes], [pages, bytes], name);
  }
});
