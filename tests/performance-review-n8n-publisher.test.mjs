import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
function invoke(argv, stdin = '', scenario = null) {
  const p = spawnSync('/usr/bin/python3', ['-B', `${ROOT}tests/performance-review-n8n-publisher-fixture.py`], {cwd: ROOT, env: {PATH: '/usr/bin:/bin'}, input: JSON.stringify({argv, stdin, scenario}), encoding: 'utf8', timeout: scenario === 'native-journal-fifo' ? 2000 : 30000});
  assert.equal(p.status, 0, p.stderr);
  const result = JSON.parse(p.stdout);
  assert.equal(result.missingEntrypoint, false, 'finite publisher public main exists');
  assert.deepEqual(result.forbidden, {credentialFile: 0, socket: 0, environment: 0});
  return result;
}

test('actual public publisher main denies missing closed source bound approval before all external ports', () => {
  for (const argv of [['stage'], ['activate'], ['readback'], ['stage', '--parent-stage']]) {
    const result = invoke(argv, '{}'); assert.equal(result.exit, 2); assert.match(result.stderr, /HOLD/);
  }
});

test('prepare binds the exact finite runtime closure without credentials or integration readiness', () => {
  const result = invoke(['prepare']); assert.equal(result.exit, 0, result.stderr);
  const prepared = JSON.parse(result.stdout);
  assert.equal(prepared.integrationReady, false);
  assert.equal(prepared.stageIntent, 'create-new-owned-inactive-only');
  assert.equal(prepared.closure.schemaVersion, 1);
  assert.ok(Object.hasOwn(prepared.closure.sourceHashes, 'scripts/publish-performance-review-mail-workflow.py'));
  assert.ok(Object.hasOwn(prepared.closure.sourceHashes, 'scripts/build-performance-review-mail-workflow.py'));
  assert.match(prepared.closure.externalHashes['MAM_VERIFY'], /^[0-9a-f]{64}$/);
  assert.match(prepared.closure.externalHashes['HTTP_SUPPLEMENT'], /^[0-9a-f]{64}$/);
});

test('stage public main performs one new inactive create and exact id full graph version readback', () => {
  const result = invoke(['stage', '--parent-stage'], '', 'stage-positive'); assert.equal(result.exit, 0, result.stderr);
  assert.deepEqual(result.calls, [['VERIFY', 'MAM'], ['GET', 'workflows?limit=25'], ['POST', 'workflows'], ['GET', 'workflows/syntheticOwnedW1']]);
  assert.equal(result.journal.phase, 'STAGED_INACTIVE');
  assert.deepEqual(result.journal.dispatches, {create: 1, activate: 0});
  assert.equal(JSON.parse(result.stdout).active, false);
});

test('closed independent verdict exact map origin and credentials are required before verification or mutation', () => {
  for (const scenario of ['wrong-source', 'missing-self-pin', 'foreign-target', 'false-review', 'placeholder']) {
    const result = invoke(['stage', '--parent-stage'], '', scenario);
    assert.equal(result.exit, 2, scenario); assert.deepEqual(result.calls, [], scenario); assert.equal(result.journal, null, scenario);
  }
  for (const argv of [['stage', '--parent-activate'], ['activate', '--parent-stage'], ['stage', '--parent-stage', '--unknown']]) {
    const result = invoke(argv, '', 'stage-positive'); assert.equal(result.exit, 2); assert.deepEqual(result.calls, []);
  }
});

const ID = 'syntheticOwnedW1';
const VERSION = '740f0100-0000-4000-8000-000000000001';
const activateArgv = ['activate', '--parent-activate', '--expected-id', ID, '--expected-version', VERSION];

test('activation has separate independent exact owned inactive version admission and verified active readback', () => {
  const result = invoke(activateArgv, '', 'activate-positive'); assert.equal(result.exit, 0, result.stderr);
  assert.deepEqual(result.calls, [['VERIFY', 'MAM'], ['GET', `workflows/${ID}`], ['POST', `workflows/${ID}/activate`], ['GET', `workflows/${ID}`]]);
  assert.deepEqual(result.journal.dispatches, {create: 1, activate: 1});
  assert.equal(result.journal.phase, 'ACTIVATED_VERIFIED'); assert.equal(JSON.parse(result.stdout).active, true);
});

test('unknown creates and contradictory first readbacks are permanently held with no repeated writes', () => {
  for (const scenario of ['create-timeout', 'create-active', 'create-id-shape', 'first-readback-version', 'first-readback-id', 'first-readback-graph']) {
    const result = invoke(['stage', '--parent-stage'], '', scenario);
    assert.equal(result.exit, 2, scenario); assert.equal(result.retryExit, 2, scenario);
    assert.equal(result.journal.phase, 'HOLD_CREATE_UNKNOWN');
    assert.equal(result.calls.filter(([method, path]) => method === 'POST' && path === 'workflows').length, 1);
    assert.equal(result.calls.some(([, path]) => path.endsWith('/activate')), false);
  }
});

test('activation denies unverified runtime missing review stale inactive version and unknown activation without a retry', () => {
  for (const scenario of ['activate-runtime-unverified', 'activate-no-review', 'activate-pre-version', 'activate-already-active', 'activate-timeout', 'activate-post-version']) {
    const result = invoke(activateArgv, '', scenario); assert.equal(result.exit, 2, scenario);
    const dispatched = ['activate-timeout', 'activate-post-version'].includes(scenario);
    assert.equal(result.calls.filter(([method]) => method === 'POST').length, dispatched ? 1 : 0, scenario);
    if (dispatched) {assert.equal(result.retryExit, 2); assert.equal(result.journal.phase, 'HOLD_ACTIVATE_UNKNOWN');}
  }
});

test('readback public main reads only the exact owned full graph and never activates', () => {
  const result = invoke(['readback', '--expected-id', ID, '--expected-version', VERSION], '', 'readback-positive');
  assert.equal(result.exit, 0, result.stderr); assert.equal(result.journal.phase, 'STAGED_INACTIVE');
  assert.deepEqual(result.calls, [['VERIFY', 'MAM'], ['GET', `workflows/${ID}`]]);
  assert.equal(JSON.parse(result.stdout).active, false);
});

test('native public stage caller uses the measured MAM verifier config helper real HTTPS request construction and fsynced journal with inert terminal transport', () => {
  const result = invoke(['stage', '--parent-stage'], '', 'native-journal'); assert.equal(result.exit, 0, result.stderr);
  const base = 'https://n8n.srv1866578.hstgr.cloud/api/v1/';
  assert.deepEqual(result.calls, [['GET', base + 'workflows?limit=1'], ['GET', base + 'workflows?limit=25'], ['POST', base + 'workflows'], ['GET', base + `workflows/${ID}`]]);
  assert.equal(JSON.parse(result.stdout).phase, 'STAGED_INACTIVE');
});

test('every authenticated native MAM API request rejects same and foreign redirects without a second dispatch', () => {
  for (const code of [301, 302, 303, 307, 308]) for (const destination of ['same', 'foreign']) {
    const result = invoke(['stage', '--parent-stage'], '', `native-redirect-${code}-${destination}`);
    assert.equal(result.exit, 2); assert.equal(result.calls.length, 2);
    assert.ok(result.calls.every(([, url]) => url.startsWith('https://n8n.srv1866578.hstgr.cloud/api/v1/')));
    assert.equal(result.calls.some(([method]) => method === 'POST'), false);
  }
});

test('native helper rejects foreign config before any authenticated request and screens escaped secret echo before journal fields', () => {
  const foreign = invoke(['stage', '--parent-stage'], '', 'native-foreign-config');
  assert.equal(foreign.exit, 2); assert.deepEqual(foreign.calls, []);
  const echo = invoke(['stage', '--parent-stage'], '', 'native-secret-echo');
  assert.equal(echo.exit, 2); assert.equal(echo.journal.phase, 'HOLD_CREATE_UNKNOWN');
  assert.equal(echo.journal.id, null);
  assert.equal(JSON.stringify(echo.journal).includes('synthetic-api-key-for-inert-fixture'), false);
  assert.equal((echo.stderr + echo.stdout).includes('synthetic-api-key-for-inert-fixture'), false);
});

test('native stage and activate execute the actual CLI defaults with measured verifier bytes and real durable journal', () => {
  for (const [scenario, argv, phase] of [['native-cli-stage', ['stage', '--parent-stage'], 'STAGED_INACTIVE'], ['native-cli-activate', activateArgv, 'ACTIVATED_VERIFIED']]) {
    const result = invoke(argv, '', scenario);
    assert.equal(result.exit, 0, result.stderr);
    assert.equal(result.native.cliEntered, true);
    assert.ok(result.native.compiledVerifier.length > 0);
    assert.ok(result.native.compiledVerifier.every(hash => hash === result.native.expectedVerifierHash));
    assert.ok(result.native.fsyncs.includes('directory'));
    assert.ok(result.native.fsyncs.includes('file'));
    assert.equal(result.native.journalMode, '0o600');
    assert.equal(result.native.stickyLock, false);
    assert.equal(result.native.secretInJournal, false);
    assert.equal(result.native.safeRequests, result.calls.length);
    assert.equal(result.journal.phase, phase);
    assert.equal(JSON.parse(result.stdout).phase, phase);
  }
  const read = invoke(['readback', '--expected-id', ID, '--expected-version', VERSION], '', 'native-readback-positive');
  assert.equal(read.exit, 0, read.stderr);
  assert.equal(read.calls.filter(([method]) => method === 'POST').length, 0);
});

test('native configuration remains unread before closed approval and rejects every nonexact configured origin before authentication', () => {
  for (const scenario of ['native-wrong-source', 'native-false-review']) {
    const result = invoke(['stage', '--parent-stage'], '', scenario);
    assert.equal(result.exit, 2); assert.deepEqual(result.calls, []);
    assert.equal(result.native.configLoads, 0);
  }
  for (const variant of ['http', 'userinfo', 'query', 'fragment', 'path', 'port', 'foreign']) {
    const result = invoke(['stage', '--parent-stage'], '', `native-config-${variant}`);
    assert.equal(result.exit, 2); assert.deepEqual(result.calls, []);
    assert.equal(result.native.configLoads, 1);
  }
});

test('native verifier create first readback and activation all refuse every redirect including HTTPS downgrades', () => {
  for (const role of ['verify', 'create', 'readback', 'activate']) for (const code of [301, 302, 303, 307, 308]) for (const destination of ['same', 'foreign', 'http']) {
    const scenario = role === 'activate' ? `native-activate-redirect-activate-${code}-${destination}` : `native-redirect-${role}-${code}-${destination}`;
    const result = invoke(role === 'activate' ? activateArgv : ['stage', '--parent-stage'], '', scenario);
    assert.equal(result.exit, 2, scenario);
    assert.equal(result.retryExit, 2, scenario);
    assert.equal(result.calls.length, {verify: 1, create: 3, readback: 4, activate: 3}[role], scenario);
    assert.ok(result.calls.every(([, url]) => url.startsWith('https://n8n.srv1866578.hstgr.cloud/api/v1/')));
    assert.equal(result.native.stickyLock, true);
  }
});

test('every native journal fsync uncertainty retains a permanent blocker even after a complete-looking final write', () => {
  const control = invoke(['stage', '--parent-stage'], '', 'native-journal');
  assert.equal(control.exit, 0);
  for (let index = 1; index <= control.native.fsyncs.length; index++) {
    const result = invoke(['stage', '--parent-stage'], '', `native-fsync-${index}`);
    assert.equal(result.exit, 2); assert.equal(result.retryExit, 2);
    assert.equal(result.native.firstAttemptFsyncs.length, index);
    assert.equal(result.native.stickyLock, true);
    assert.equal(result.calls.filter(([method]) => method === 'POST').length, index <= control.native.createAtFsync ? 0 : 1);
  }
});

test('native unknown POST interrupt and first-readback contradiction never repeat an authenticated operation', () => {
  for (const scenario of ['native-create-timeout', 'native-create-interrupt', 'native-readback-version', 'native-activate-timeout']) {
    const result = invoke(scenario.includes('activate') ? activateArgv : ['stage', '--parent-stage'], '', scenario);
    assert.equal(result.exit, 2); assert.equal(result.retryExit, 2);
    assert.equal(result.native.stickyLock, true);
    assert.equal(result.calls.filter(([method]) => method === 'POST').length, 1);
    assert.ok(result.journal.phase.startsWith('HOLD_'));
  }
});

test('native valid JSON Unicode secret echoes in ids versions and property names never reach any fsynced projection', () => {
  for (const scenario of ['native-secret-echo', 'native-secret-version', 'native-secret-key']) {
    const result = invoke(['stage', '--parent-stage'], '', scenario);
    assert.equal(result.exit, 2); assert.equal(result.retryExit, 2);
    assert.equal(result.journal.phase, 'HOLD_CREATE_UNKNOWN');
    assert.equal(result.journal.id, null); assert.equal(result.journal.versionId, null);
    assert.equal(result.native.secretInJournal, false);
    assert.equal(result.native.stickyLock, true);
    assert.equal(result.calls.length, 3);
  }
});

test('native response byte bound and HTTP errors stop before workflow creation without diagnostics containing payloads', () => {
  for (const scenario of ['native-body-bound', 'native-http-error']) {
    const result = invoke(['stage', '--parent-stage'], '', scenario);
    assert.equal(result.exit, 2); assert.equal(result.calls.length, 2);
    assert.equal(result.calls.some(([method]) => method === 'POST'), false);
    assert.equal(result.stderr, 'HOLD_PUBLICATION_NO_RETRY\n');
  }
});

test('native journal rejects symbolic links and FIFO paths without blocking or authenticating', () => {
  for (const scenario of ['native-journal-symlink', 'native-journal-fifo']) {
    const result = invoke(['stage', '--parent-stage'], '', scenario);
    assert.equal(result.exit, 2); assert.equal(result.retryExit, 2);
    assert.deepEqual(result.calls, []);
    assert.equal(result.native.stickyLock, true);
  }
});
