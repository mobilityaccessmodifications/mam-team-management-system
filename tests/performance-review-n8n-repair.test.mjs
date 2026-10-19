import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
function invoke(scenario) {
  const p = spawnSync('/usr/bin/python3', ['-B', `${ROOT}tests/performance-review-n8n-repair-fixture.py`, scenario, tmpdir()], {cwd: ROOT, env: {PATH: '/usr/bin:/bin'}, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024});
  assert.equal(p.status, 0, p.stderr);
  const result = JSON.parse(p.stdout);
  assert.deepEqual(result.forbidden, {credentialFile: 0, socket: 0, environment: 0, privateSource: 0});
  assert.ok(result.metrics.mainDefaultEntrances > 0);
  assert.ok(result.metrics.compiledVerifier.every(hash => hash === '6303d22c62b88c0fe80412be20987b7fb98b5c534e7447df1a950732a7516d8e'));
  assert.equal(result.actualEmails, 0);
  return result;
}

test('repair exact positive stage activation control', () => {
  const control = invoke('control');
  assert.deepEqual(control.steps.map(s => s.exit), [0, 0]);
});
test('repair exact finite JSON number 2 and 2.0 are equivalent without Boolean coercion', () => {
  const result = invoke('number-control');
  assert.deepEqual(result.steps.map(s => s.exit), [0, 0]);
});
for (const role of ['create', 'first', 'preactivate', 'ack', 'final']) for (const fault of ['missing', 'publication', 'settings', 'node', 'true']) {
  test(`repair exact ${role} ${fault} sticky denial through actual CLI`, () => {
    const result = invoke(`exact-${role}-${fault}`);
    assert.deepEqual(result.faults, [role]);
    const index = ['preactivate', 'ack', 'final'].includes(role) ? 1 : 0;
    const failed = result.steps[index];
    assert.equal(failed.exit, 2, `${role}/${fault}`);
    assert.equal(failed.lockRetained, true);
    assert.equal(result.steps[index + 1].exit, 2);
    assert.deepEqual(result.steps[index + 1].calls, []);
    assert.equal(result.steps[index + 1].configLoads, 0);
    const posts = failed.calls.filter(c => c.method === 'POST');
    assert.equal(posts.length, role === 'preactivate' ? 0 : 1);
    if (['create', 'first', 'ack', 'final'].includes(role)) assert.match(failed.journal.phase, /^HOLD_(CREATE|ACTIVATE)_UNKNOWN$/);
  });
}
for (const state of ['unknown', 'unknown-unlock', 'not-entered', 'staged']) {
  test(`repair canonical fence ${state} denies new output aliases checkout and source before configuration`, () => {
    const result = invoke(`fence-${state}`);
    assert.equal(result.steps[0].exit, state === 'staged' ? 0 : 2);
    if (state.startsWith('unknown')) assert.deepEqual(result.faults, ['create']);
    if (state === 'not-entered') assert.deepEqual(result.faults, ['inventory']);
    for (const step of result.steps.slice(1)) {
      assert.equal(step.exit, 2);
      assert.equal(step.configLoads, 0);
      assert.deepEqual(step.calls, []);
    }
    assert.equal(result.steps.flatMap(s => s.calls).filter(c => c.method === 'POST').length, state === 'not-entered' ? 0 : 1);
  });
}
test('repair measured loaded publisher timeout19 mismatch is denied before configuration API and journal', () => {
  const result = invoke('loaded-mismatch');
  assert.notEqual(result.executedSha256, result.sourceSha256);
  assert.equal(result.steps[0].exit, 2);
  assert.deepEqual(result.steps[0].calls, []);
  assert.equal(result.metrics.configLoads, 0);
  assert.deepEqual(result.metrics.fsyncs, []);
});
for (const role of ['verify', 'inventory', 'create', 'first', 'preactivate', 'ack', 'final', 'input', 'journal']) for (const token of ['nan', 'inf', 'negative', 'overflow', 'duplicate']) {
  test(`repair strict JSON ${role} ${token} rejects before settling or followup`, () => {
    const result = invoke(`json-${role}-${token}`);
    const index = ['preactivate', 'ack', 'final', 'journal'].includes(role) ? 1 : 0;
    const failed = result.steps[index];
    assert.equal(failed.exit, 2);
    assert.equal(result.steps[index + 1].exit, 2);
    assert.deepEqual(result.steps[index + 1].calls, []);
    assert.equal(result.steps[index + 1].configLoads, 0);
    if (role === 'input') {
      assert.equal(failed.acquisitions, 0);
      assert.equal(failed.configLoads, 0);
    } else if (role === 'journal') {
      assert.equal(failed.configLoads, 0);
    } else {
      assert.deepEqual(result.faults, [role]);
      assert.equal(failed.lockRetained, true);
      assert.equal(failed.calls.filter(c => c.method === 'POST').length, ['create', 'first', 'ack', 'final'].includes(role) ? 1 : 0);
      if (['create', 'first', 'ack', 'final'].includes(role)) assert.match(failed.journal.phase, /^HOLD_/);
    }
  });
}
for (const token of ['nan', 'inf', 'negative']) test(`repair strict JSON serializer ${token} rejects nonfinite numbers`, () => {
  const result = invoke(`json-serializer-${token}`);
  assert.equal(result.serializerRejected, true);
  assert.equal(result.nonfiniteEquality, false);
});
test('repair inventory paginates complete 131 synthetic rows over six observed-size bounded responses', () => {
  const result = invoke('inventory-positive');
  assert.equal(result.steps[0].exit, 0);
  assert.equal(result.inventoryResponses.length, 6);
  assert.equal(result.inventoryResponses.reduce((sum, page) => sum + page.bytes, 0), 17450164);
  assert.deepEqual(result.inventoryResponses.map(p => p.rows), [25, 25, 25, 25, 25, 6]);
  assert.ok(result.inventoryResponses.every(p => p.limit === 25 && p.bytes <= 8388608));
  for (const request of result.steps[0].calls.filter(c => c.role === 'inventory').slice(1)) {
    const url = new URL(request.url);
    assert.ok(url.searchParams.get('cursor').includes('+/=雪 %'));
    assert.match(request.url, /%20.*%2B%2F%3D%E9%9B%AA%20%25$/);
  }
  assert.equal(result.steps[0].calls.filter(c => c.method === 'POST').length, 1);
});
for (const fault of ['duplicate', 'name', 'path', 'ready', 'missingcursor', 'missingdata', 'extra', 'error', 'badrows', 'badid', 'badnode', 'emptycursor', 'cursorbool', 'cursorlong', 'secret', 'manyrows', 'body', 'cycle', 'pages', 'bytes', ...[301, 302, 303, 307, 308].flatMap(code => [`redirect-${code}-same`, `redirect-${code}-foreign`])]) {
  test(`repair inventory ${fault} holds complete scan before any POST`, () => {
    const result = invoke(`inventory-${fault}`);
    const step = result.steps[0];
    assert.equal(step.exit, 2);
    assert.equal(step.calls.filter(c => c.method === 'POST').length, 0);
    const requests = step.calls.filter(c => c.role === 'inventory');
    assert.equal(requests.length, fault === 'pages' ? 32 : fault === 'bytes' ? 10 : fault === 'cycle' ? 2 : 6);
    assert.equal(result.inventoryResponses.length, requests.length);
    if (!['pages', 'bytes'].includes(fault)) assert.ok(result.faults.includes(`inventory-${fault}`));
  });
}
test('repair activation pins only acknowledged versionId when provider latest changes after preGET', () => {
  const result = invoke('activation-pinned-version');
  assert.deepEqual(result.activationBodies, [{versionId: '740f0100-0000-4000-8000-000000000001'}]);
  assert.deepEqual(result.steps.map(s => s.exit), [0, 0]);
  assert.equal(result.steps[1].calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(result.steps[1].journal.phase, 'ACTIVATED_VERIFIED');
});
test('repair canonical and output journal every fsync uncertainty preserves both replay fences', () => {
  const control = invoke('fsync-control');
  assert.equal(control.steps[0].exit, 0);
  const failures = [];
  for (let index = 1; index <= control.metrics.fsyncs.length; index++) {
    const result = invoke(`fsync-${index}`);
    if (result.steps[0].exit !== 2 || (!result.steps[0].lockRetained && !result.steps[0].canonicalLockRetained) || result.steps.slice(1).some(s => s.exit !== 2 || s.calls.length !== 0 || s.configLoads !== 0)
      || result.steps.flatMap(s => s.calls).filter(c => c.method === 'POST').length !== (index <= control.metrics.createAtFsync ? 0 : 1)) failures.push(index);
  }
  assert.deepEqual(failures, []);
});
test('repair unsigned exact source map cannot admit stage before configuration or journal effects', () => {
  const result = invoke('false-source');
  assert.equal(result.steps[0].exit, 2);
  assert.equal(result.metrics.configLoads, 0);
  assert.deepEqual(result.steps[0].calls, []);
  assert.deepEqual(result.metrics.fsyncs, []);
});
