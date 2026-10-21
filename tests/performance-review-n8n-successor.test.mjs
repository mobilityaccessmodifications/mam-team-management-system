import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const scratch = process.env.MAM_SUCCESSOR_FIXTURE_ROOT || process.env.TMPDIR || tmpdir();
function run(scenario) {
  const owned = mkdtempSync(join(scratch, 'mam-successor-'));
  const command = ['-B', join(root, 'tests/performance-review-n8n-successor-fixture.py'), scenario, owned];
  let oracle = null;
  if (scenario === 'native-schedule-initialization') {
    const producer = spawnSync(process.execPath, [join(root, 'tests/performance-review-n8n-successor-static-data-fixture.cjs')], { cwd: root, encoding: 'utf8', timeout: 5000 });
    writeFileSync(join(owned, 'producer.stdout'), producer.stdout || '');
    writeFileSync(join(owned, 'producer.stderr'), producer.stderr || '');
    writeFileSync(join(owned, 'producer.exit.json'), JSON.stringify({ exit: producer.status, signal: producer.signal }));
    assert.equal(producer.status, 0, producer.stderr);
    oracle = JSON.parse(producer.stdout);
    assert.equal(oracle.emitted, 0);
    assert.equal(oracle.registered, 1);
  }
  const child = spawnSync('python3', command, { cwd: root, input: JSON.stringify(oracle), encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  writeFileSync(join(owned, 'stdout'), child.stdout || '');
  writeFileSync(join(owned, 'stderr'), child.stderr || '');
  writeFileSync(join(owned, 'exit.json'), JSON.stringify({ command, exit: child.status, signal: child.signal, error: child.error?.code || null }));
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  if (process.env.MAM_SUCCESSOR_CASE_INDEX) appendFileSync(process.env.MAM_SUCCESSOR_CASE_INDEX, JSON.stringify({ scenario, owned, command, exit: child.status }) + '\n');
  assert.equal(result.setupFailure, undefined, JSON.stringify(result));
  assert.equal(result.missingEntrypoint, undefined, 'same-ID successor entrypoint is missing');
  assert.deepEqual(result.forbidden, { credential: 0, environment: 0, network: 0, subprocess: 0, realMutation: 0 });
  // A passing scenario leaves nothing to diagnose unless a caller indexed it for later review.
  if (!process.env.MAM_SUCCESSOR_CASE_INDEX && process.env.MAM_KEEP_TEST_PGDATA !== '1') rmSync(owned, { recursive: true, force: true });
  return result;
}

test('historical Boolean schemaVersion cannot impersonate a completed integer creation journal', () => {
  const result = run('historical-boolean-schema');
  assert.equal(result.exits.at(-1), 2);
  assert.equal(result.calls.length, 0);
});

for (const scenario of ['historical-authority-waiver', 'historical-prepared-graph', 'unbound-installed-source']) {
  test(`successor validates supplier provenance ${scenario} before transport`, () => {
    const result = run(scenario);
    assert.equal(result.exits.at(-1), 2);
    assert.equal(result.calls.length, 0);
    assert.equal(result.configLoads, 0);
  });
}

test('stale publisher source is rejected before its top-level credential read can execute', () => {
  const result = run('load-before-pin');
  assert.deepEqual(result.exits, [0, 2]);
  assert.equal(result.calls.length, 0);
  assert.equal(result.configLoads, 0);
});

test('credential-free prepare cannot execute an unapproved changed publisher top level', () => {
  const result = run('prepare-publisher-escape');
  assert.deepEqual(result.exits, [2]);
  assert.equal(result.calls.length, 0);
});

for (const scenario of ['scope-webhook-path', 'scope-sender-url', 'current-runtime-scope']) {
  test(`successor keeps original paths and sender scope for ${scenario}`, () => {
    const result = run(scenario);
    assert.deepEqual(result.exits, [2]);
    assert.equal(result.calls.length, 0);
    assert.equal(result.configLoads, 0);
  });
}

test('a final journal fsync failure keeps the successful-looking correction sticky HOLD', () => {
  const result = run('finish-fsync');
  assert.deepEqual(result.exits, [0, 2]);
  assert.equal(result.calls.filter(x => x.method === 'PUT').length, 1);
  assert.equal(result.calls.filter(x => x.method === 'POST').length, 0);
  assert.equal(result.state.phase, 'HOLD_CONTINUATION_NO_RETRY');
  assert.deepEqual(result.state.originalFailure, { type: 'OSError', code: null, operation: 'correct-inactive:GET-readback' });
  assert.equal(result.state.sourceHold, false);
});

for (const scenario of ['source-drift-on-put', 'source-drift-on-put-timeout', 'source-drift-on-finish']) {
  test(`successor checks exceptional and final source custody ${scenario}`, () => {
    const result = run(scenario);
    assert.equal(result.exits.at(-1), 2);
    assert.equal(result.state.phase, 'HOLD_CONTINUATION_NO_RETRY');
    assert.equal(result.lockRetained, true);
    assert.equal(result.calls.filter(x => x.method === 'PUT').length, 1);
    assert.equal(result.calls.filter(x => x.method === 'POST').length, 0);
    const operation = scenario === 'source-drift-on-finish' ? 'correct-inactive:GET-readback' : 'correct-inactive:PUT';
    assert.deepEqual(result.state.originalFailure, { type: scenario.endsWith('-timeout') ? 'TimeoutError' : 'ValueError', code: scenario.endsWith('-timeout') ? null : 'HOLD_SOURCE_DRIFT', operation });
    assert.equal(result.state.lastEnteredOperation, operation);
    assert.equal(result.state.sourceHold, true);
  });
}

test('successor closes prepare -> one same-ID inactive PUT -> versioned activation -> GET-only readback with old permissions off', () => {
  const result = run('positive');
  assert.deepEqual(result.exits, [0, 0, 0, 0]);
  assert.equal(result.calls.filter(x => x.method === 'PUT').length, 1);
  assert.equal(result.calls.filter(x => x.method === 'POST').length, 1);
  assert.ok(result.calls.every(x => x.path === 'workflows?limit=1' || x.path === 'workflows/syntheticOwnedW1' || x.path === 'workflows/syntheticOwnedW1/activate'));
  assert.deepEqual(result.calls.find(x => x.method === 'POST').body, { versionId: '740f0100-0000-4000-8000-000000000002' });
  assert.equal(result.state.phase, 'ACTIVATED_VERIFIED');
  assert.deepEqual(result.state.dispatches, { correct: 1, activate: 1 });
  assert.equal(result.historyUnchanged, true);
  assert.ok(result.putAtFsync > 0);
  assert.ok(result.postAtFsync > result.putAtFsync);
  assert.ok(result.loaded.every(x => x.sha256 === x.expected));
  assert.equal(result.state.schemaVersion, 2);
  assert.equal(result.state.originalFailure, null);
  assert.equal(result.state.sourceHold, false);
  assert.equal(result.state.lastEnteredOperation, 'readback:GET');
});

for (const scenario of ['wrong-graph', 'stale-source', 'source-after-deployment', 'boolean-outbox', 'missing-grant', 'boolean-grant', 'false-review', 'foreign-expected-id', 'foreign-expected-version', 'duplicate-json', 'nonfinite-json', 'overflow-json', 'existing-child', 'child-symlink', 'evidence-child-escape', 'review-deadline-expired', 'review-deadline-boolean', 'review-deadline-missing']) {
  test(`successor admission rejects ${scenario} before configuration or transport`, () => {
    const result = run(scenario);
    assert.deepEqual(result.exits, [0, 2]);
    assert.equal(result.calls.length, 0);
    assert.equal(result.configLoads, 0);
    assert.equal(result.historyUnchanged, true);
  });
}

for (const point of ['correct-pre', 'correct-ack', 'correct-first', 'activate-pre', 'activate-ack', 'activate-first']) {
  const faults = ['id', 'version', 'boolean-version', 'active', 'boolean-active', 'publication', 'missing-publication', 'connections', 'settings', 'static', 'raw-static', 'missing-static', 'shared'];
  if (point === 'correct-ack') faults.push('same-version', 'timeout', 'interrupt', 'secret-key', 'secret-nested', 'secret-version');
  if (point === 'activate-ack') faults.push('timeout', 'interrupt', 'inner-version', 'inner-id', 'inner-null', 'inner-bool', 'publication-graph');
  if (point === 'activate-first') faults.push('inner-version', 'inner-id', 'inner-null', 'inner-bool', 'publication-graph');
  for (const fault of faults) {
    const scenario = `${point}-${fault}`;
    test(`successor ${scenario} is sticky and cannot replay a restored-looking target`, () => {
      const result = run(scenario);
      assert.ok(result.faultEntered.includes(scenario));
      assert.equal(result.exits.at(-1), 2);
      assert.equal(result.state.phase, 'HOLD_CONTINUATION_NO_RETRY');
      assert.equal(result.lockRetained, true);
      assert.equal(result.historyUnchanged, true);
      assert.equal(result.secretPersisted, false);
      assert.equal(result.calls.filter(x => x.method === 'PUT').length, point === 'correct-pre' ? 0 : 1);
      assert.equal(result.calls.filter(x => x.method === 'POST').length, point.startsWith('correct') || point === 'activate-pre' ? 0 : 1);
    });
  }
}

test('expanded publication may omit inner metadata only with strict acknowledged outer ownership', () => {
  const result = run('publication-inner-omitted');
  assert.deepEqual(result.exits, [0, 0, 0, 0]);
  assert.equal(result.state.phase, 'ACTIVATED_VERIFIED');
});

for (const scenario of ['full-source-map-positive', 'native-schedule-initialization', 'review-deadline-positive']) {
  test(`successor positive producer contract ${scenario}`, () => {
    const result = run(scenario);
    assert.deepEqual(result.exits, [0, 0, 0, 0]);
    assert.equal(result.state.phase, 'ACTIVATED_VERIFIED');
    assert.equal(result.historyUnchanged, true);
  });
}

test('activation consumes current provider evidence rather than the old false flag or a substitute Boolean', () => {
  const result = run('activation-no-provider');
  assert.deepEqual(result.exits, [0, 0, 2]);
  assert.equal(result.calls.filter(x => x.method === 'POST').length, 0);
  assert.equal(result.historyUnchanged, true);
});

for (const scenario of ['old-stage-denied', 'old-activate-denied', 'old-reset-denied']) {
  test(`original public entry preserves denied obsolete authority ${scenario}`, () => {
    const result = run(scenario);
    assert.deepEqual(result.exits, [2]);
    assert.equal(result.calls.length, 0);
    assert.equal(result.historyUnchanged, true);
  });
}

test('inactive successor GET-only readback needs neither activation nor runtime permission', () => {
  const result = run('inactive-readback');
  assert.deepEqual(result.exits, [0, 0, 0]);
  assert.equal(result.state.phase, 'CORRECTED_INACTIVE_VERIFIED');
  assert.equal(result.calls.filter(x => x.method === 'POST').length, 0);
});

test('current approval is rechecked after the last GET and before PUT intent', () => {
  const result = run('review-expired-preput');
  assert.deepEqual(result.exits, [0, 2]);
  assert.equal(result.calls.filter(x => x.method === 'PUT').length, 0);
  assert.equal(result.state.dispatches.correct, 0);
  assert.equal(result.lockRetained, true);
});

for (const scenario of ['activate-ack-systemexit-source', 'activate-ack-systemexit-only']) {
  test(`NS-R1-01 public main retains primary failure and independent source HOLD ${scenario}`, () => {
    const result = run(scenario);
    assert.deepEqual(result.exits, [0, 0, 2]);
    assert.ok(result.faultEntered.includes(scenario));
    assert.equal(result.calls.filter(x => x.method === 'PUT').length, 1);
    assert.equal(result.calls.filter(x => x.method === 'POST').length, 1);
    assert.equal(result.calls.at(-1).method, 'POST');
    assert.deepEqual(result.state.dispatches, { correct: 1, activate: 1 });
    assert.equal(result.state.phase, 'HOLD_CONTINUATION_NO_RETRY');
    assert.equal(result.lockRetained, true);
    assert.equal(result.historyUnchanged, true);
    assert.equal(result.secretPersisted, false);
    assert.deepEqual(result.state.originalFailure, { type: 'SystemExit', code: 73, operation: 'activate-successor:POST' });
    assert.equal(result.state.lastEnteredOperation, 'activate-successor:POST');
    assert.equal(result.state.sourceHold, scenario.endsWith('-source'));
  });
}

function assertDiagnosticHold(result, failure, sourceHold, dispatches) {
  assert.equal(result.exits.at(-1), 2);
  assert.equal(result.state.phase, 'HOLD_CONTINUATION_NO_RETRY');
  assert.deepEqual(result.state.originalFailure, failure);
  assert.equal(result.state.lastEnteredOperation, failure.operation);
  assert.equal(result.state.sourceHold, sourceHold);
  assert.deepEqual(result.state.dispatches, dispatches);
  assert.equal(result.calls.filter(x => x.method === 'PUT').length, dispatches.correct);
  assert.equal(result.calls.filter(x => x.method === 'POST').length, dispatches.activate);
  assert.equal(result.lockRetained, true);
  assert.equal(result.historyUnchanged, true);
  assert.equal(result.secretPersisted, false);
  assert.ok(result.loaded.every(x => x.sha256 === x.expected));
  assert.equal(result.outputs.at(-1).stdout, '');
  assert.equal(result.outputs.at(-1).stderr, 'HOLD_CONTINUATION_NO_RETRY\n');
}

for (const [point, operation, dispatches, exits] of [
  ['verify', 'verify', { correct: 0, activate: 0 }, [0, 2]],
  ['correct-pre', 'correct-inactive:GET', { correct: 0, activate: 0 }, [0, 2]],
  ['correct-ack', 'correct-inactive:PUT', { correct: 1, activate: 0 }, [0, 2]],
  ['correct-first', 'correct-inactive:GET-readback', { correct: 1, activate: 0 }, [0, 2]],
  ['activate-pre', 'activate-successor:GET', { correct: 1, activate: 0 }, [0, 0, 2]],
  ['activate-first', 'activate-successor:GET-readback', { correct: 1, activate: 1 }, [0, 0, 2]],
  ['readback', 'readback:GET', { correct: 1, activate: 1 }, [0, 0, 0, 2]],
]) {
  test(`NS-R1-01 sibling exceptional boundary ${point}`, () => {
    for (const fault of ['systemexit-source', 'systemexit-only', 'interrupt-source']) {
      const scenario = `${point}-${fault}`;
      const result = run(scenario);
      assert.deepEqual(result.exits, exits);
      assert.ok(result.faultEntered.includes(scenario));
      assertDiagnosticHold(result, { type: fault === 'interrupt-source' ? 'KeyboardInterrupt' : 'SystemExit', code: fault === 'interrupt-source' ? null : 73, operation }, fault !== 'systemexit-only', dispatches);
    }
  });
}

test('NS-R1-01 allowlists and secret-screens every failure projection field', () => {
  for (const [fault, type, code, operation] of [
    ['known-code-source', 'ValueError', 'HOLD_RETAINED_STATIC_DATA', 'activate-successor:POST'],
    ['unknown-code-source', 'ValueError', null, 'activate-successor:POST'],
    ['unknown-class-source', 'UnknownError', null, 'activate-successor:POST'],
    ['systemexit-zero-source', 'SystemExit', 0, 'activate-successor:POST'],
    ['systemexit-one-source', 'SystemExit', 1, 'activate-successor:POST'],
    ['systemexit-two-source', 'SystemExit', 2, 'activate-successor:POST'],
    ['systemexit-string-source', 'SystemExit', null, 'activate-successor:POST'],
    ['systemexit-bool-source', 'SystemExit', null, 'activate-successor:POST'],
    ['systemexit-unknown-number-source', 'SystemExit', null, 'activate-successor:POST'],
    ['code-secret-source', 'ValueError', null, 'activate-successor:POST'],
    ['operation-secret-source', 'SystemExit', 73, null],
    ['type-secret-source', 'UnknownError', null, 'activate-successor:POST'],
  ]) {
    const result = run(`activate-ack-${fault}`);
    assert.deepEqual(result.exits, [0, 0, 2]);
    assert.equal(result.calls.at(-1).method, 'POST');
    assertDiagnosticHold(result, { type, code, operation }, true, { correct: 1, activate: 1 });
  }
});

test('NS-R1-01 source HOLD stays sticky after later source checks recover', () => {
  const result = run('activate-ack-systemexit-source-once');
  assert.deepEqual(result.exits, [0, 0, 2]);
  assert.equal(result.sourceFaultReads, 1);
  assert.equal(result.sourceDriftRestored, true);
  assertDiagnosticHold(result, { type: 'SystemExit', code: 73, operation: 'activate-successor:POST' }, true, { correct: 1, activate: 1 });
});

test('NS-R1-01 cleanup interrupts without a primary remain closed', () => {
  for (const [scenario, type, code] of [['finish-systemexit', 'SystemExit', 73], ['finish-interrupt', 'KeyboardInterrupt', null]]) {
    const result = run(scenario);
    assert.deepEqual(result.exits, [0, 2]);
    assertDiagnosticHold(result, { type, code, operation: 'correct-inactive:GET-readback' }, false, { correct: 1, activate: 0 });
  }
});

test('NS-R1-01 source-final interruption without a primary is a distinct sticky HOLD', () => {
  const result = run('source-final-systemexit');
  assert.deepEqual(result.exits, [0, 2]);
  assertDiagnosticHold(result, { type: 'SystemExit', code: 73, operation: 'correct-inactive:GET-readback' }, true, { correct: 1, activate: 0 });
});

test('NS-R1-01 diagnostic fsync failure cannot replace the primary or authorize retry', () => {
  const retained = run('activate-ack-systemexit-hold-fsync');
  assert.deepEqual(retained.exits, [0, 0, 2]);
  assertDiagnosticHold(retained, { type: 'SystemExit', code: 73, operation: 'activate-successor:POST' }, false, { correct: 1, activate: 1 });
  const blocked = run('activate-ack-systemexit-persist-fsync');
  assert.deepEqual(blocked.exits, [0, 0, 2]);
  assert.deepEqual(blocked.state.dispatches, { correct: 1, activate: 1 });
  assert.equal(blocked.state.phase, 'HOLD_ACTIVATE_UNKNOWN');
  assert.equal(blocked.state.originalFailure, null);
  assert.equal(blocked.lockRetained, true);
  assert.equal(blocked.pendingRetained, true);
  assert.equal(blocked.calls.filter(x => x.method === 'PUT').length, 1);
  assert.equal(blocked.calls.filter(x => x.method === 'POST').length, 1);
  assert.equal(blocked.calls.at(-1).method, 'POST');
  assert.equal(blocked.outputs.at(-1).stdout, '');
  assert.equal(blocked.outputs.at(-1).stderr, 'HOLD_CONTINUATION_NO_RETRY\n');
  assert.equal(blocked.historyUnchanged, true);
  assert.equal(blocked.secretPersisted, false);
});

test('NS-R1-01 readback staticData denial retains its own operation and safe code', () => {
  const result = run('readback-static');
  assert.deepEqual(result.exits, [0, 0, 0, 2]);
  assertDiagnosticHold(result, { type: 'ValueError', code: 'HOLD_RETAINED_STATIC_DATA', operation: 'readback:GET' }, false, { correct: 1, activate: 1 });
});

test('NS-R1-01 closed successor journal rejects held, mistyped and undeclared diagnostics', () => {
  for (const scenario of ['journal-schema-old', 'journal-source-boolean', 'journal-source-held', 'journal-primary-held', 'journal-extra', 'journal-last-operation']) {
    const result = run(scenario);
    assert.deepEqual(result.exits, [0, 0, 2]);
    assert.equal(result.calls.filter(x => x.method === 'PUT').length, 1);
    assert.equal(result.calls.filter(x => x.method === 'POST').length, 0);
    assert.equal(result.state.phase, 'HOLD_CONTINUATION_NO_RETRY');
    assert.equal(result.state.sourceHold, scenario === 'journal-source-held');
    assert.equal(result.lockRetained, true);
    assert.equal(result.historyUnchanged, true);
    assert.equal(result.secretPersisted, false);
  }
});

test('NS-R1-01 successful readback records the last entered operation without granting activation', () => {
  const result = run('inactive-readback-reactivate');
  assert.deepEqual(result.exits, [0, 0, 0, 0, 0]);
  assert.equal(result.state.schemaVersion, 2);
  assert.equal(result.state.phase, 'ACTIVATED_VERIFIED');
  assert.equal(result.state.originalFailure, null);
  assert.equal(result.state.sourceHold, false);
  assert.equal(result.state.lastEnteredOperation, 'readback:GET');
  assert.deepEqual(result.state.dispatches, { correct: 1, activate: 1 });
  assert.equal(result.calls.filter(x => x.method === 'PUT').length, 1);
  assert.equal(result.calls.filter(x => x.method === 'POST').length, 1);
  assert.deepEqual(result.calls.find(x => x.method === 'POST').body, { versionId: '740f0100-0000-4000-8000-000000000002' });
  assert.equal(result.historyUnchanged, true);
});

for (const [scenario, type, code, operation, sourceHold] of [
  ['init-code-collision', 'ValueError', null, 'transport-initialize', false],
  ['init-type-collision', 'UnknownError', null, 'transport-initialize', false],
  ['init-operation-collision', 'KeyboardInterrupt', null, null, false],
  ['init-clean-interrupt', 'KeyboardInterrupt', null, 'transport-initialize', false],
  ['init-clean-reject', 'ValueError', 'HOLD_MAM_CONFIG_TARGET', 'transport-initialize', false],
  ['init-clean-systemexit', 'SystemExit', 73, 'transport-initialize', false],
  ['init-operation-collision-systemexit', 'SystemExit', 73, null, false],
  ['init-type-collision-source-once', 'UnknownError', null, 'transport-initialize', true],
  ['init-clean-reject-replay', 'ValueError', 'HOLD_MAM_CONFIG_TARGET', 'transport-initialize', false],
]) {
  test(`NS-R1-01-INIT-PRIVACY ${scenario} persists only safe diagnostics before ports return`, () => {
    const result = run(scenario);
    assert.equal(result.secretPersisted, false, 'initializer diagnostic must not persist the synthetic secret');
    assert.deepEqual(result.exits, scenario.endsWith('-replay') ? [0, 2, 2] : [0, 2]);
    assert.ok(result.faultEntered.includes(scenario));
    assert.equal(result.configLoads, 1);
    assert.equal(result.calls.length, 0);
    assertDiagnosticHold(result, { type, code, operation }, sourceHold, { correct: 0, activate: 0 });
    if (sourceHold) {
      assert.equal(result.sourceFaultReads, 1);
      assert.equal(result.sourceDriftRestored, true);
    }
  });
}

for (const scenario of ['init-loader-interrupt', 'init-config-interrupt']) {
  test(`NS-R1-01-INIT-PRIVACY ${scenario} retains unknown intent when credential context is unavailable`, () => {
    const result = run(scenario);
    assert.deepEqual(result.exits, [0, 2]);
    assert.ok(result.faultEntered.includes(scenario));
    assert.equal(result.configLoads, scenario === 'init-loader-interrupt' ? 0 : 1);
    assert.equal(result.calls.length, 0);
    assert.equal(result.state.phase, 'HOLD_NOT_ENTERED');
    assert.equal(result.state.originalFailure, null);
    assert.equal(result.state.lastEnteredOperation, null);
    assert.equal(result.state.sourceHold, false);
    assert.deepEqual(result.state.dispatches, { correct: 0, activate: 0 });
    assert.equal(result.lockRetained, true);
    assert.equal(result.historyUnchanged, true);
    assert.equal(result.secretPersisted, false);
    assert.equal(result.outputs.at(-1).stdout, '');
    assert.equal(result.outputs.at(-1).stderr, 'HOLD_CONTINUATION_NO_RETRY\n');
  });
}
