import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const QA = join(ROOT, 'qa-evidence');

function specialArtifacts(directory) {
  const found = [];
  function visit(path) {
    const info = lstatSync(path);
    if (info.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name));
    } else if (!info.isFile()) found.push(path);
  }
  try { visit(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return found;
}

function invoke(scenario, directory, withoutTmpdir = false) {
  const env = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' };
  env[withoutTmpdir ? 'TEMP' : 'TMPDIR'] = directory;
  const child = spawnSync('python3', ['-B', join(ROOT, 'tests/performance-review-n8n-publisher-fixture.py')], {
    cwd: ROOT,
    env,
    input: JSON.stringify({ argv: ['stage', '--parent-stage'], scenario }),
    encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.deepEqual(result.forbidden, { credentialFile: 0, socket: 0, environment: 0 });
  return result;
}

function assertTypedCapture(result, directory) {
  const capture = result.fixtureArtifacts;
  assert.equal(capture.classification, 'SYNTHETIC_INERT_TYPED_CAPTURE_BEFORE_OWNED_CLEANUP');
  assert.equal(capture.cleanupComplete, true);
  assert.equal(capture.capturedAfterRetry, result.retryExit);
  assert.equal(capture.logicalStickyLockBeforeCleanup, result.native.stickyLock);
  assert.equal(isAbsolute(capture.root), true);
  assert.equal(capture.root.startsWith(realpathSync(directory) + sep), true);
  const fromSource = relative(ROOT, capture.root);
  assert.ok(fromSource === '..' || fromSource.startsWith('..' + sep) || isAbsolute(fromSource));
  assert.throws(() => lstatSync(capture.root), { code: 'ENOENT' });
  assert.equal(capture.entries[0].type, 'directory');
  assert.equal(capture.entries[0].mode, '0o700');
  for (const entry of capture.entries) {
    assert.equal(isAbsolute(entry.path), false);
    assert.equal(entry.path.split(sep).includes('..'), false);
    if (entry.type === 'regular') {
      const bytes = Buffer.from(entry.contentBase64, 'base64');
      assert.equal(bytes.length, entry.bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
    } else {
      assert.equal(Object.hasOwn(entry, 'contentBase64'), false);
      assert.equal(Object.hasOwn(entry, 'sha256'), false);
    }
  }
  return capture;
}

test('native negative journal cases leave no special source artifacts', t => {
  const directory = mkdtempSync(join(tmpdir(), 'mam-n8n-build-artifacts-'));
  try {
    const results = ['native-journal-fifo', 'native-journal-symlink'].map(scenario => ({ scenario, result: invoke(scenario, directory) }));
    assert.deepEqual(specialArtifacts(QA), [], 'actual native generator must not leave scanner-visible FIFO or symlink');
    for (const { scenario, result } of results) {
      t.diagnostic(JSON.stringify({ scenario, result }));
      assert.equal(result.exit, 2);
      assert.equal(result.retryExit, 2);
      assert.equal(result.native.stickyLock, true);
      assert.deepEqual(result.calls, []);
      const capture = assertTypedCapture(result, directory);
      if (scenario.endsWith('fifo')) {
        assert.equal(capture.entries.filter(entry => entry.type === 'fifo').length, 1);
      } else {
        const link = capture.entries.find(entry => entry.type === 'symlink');
        const target = capture.entries.find(entry => entry.path === link.path + '.synthetic-target');
        assert.equal(link.target, join(capture.root, target.path));
        assert.equal(Buffer.from(target.contentBase64, 'base64').toString(), 'synthetic protected bytes\n');
      }
      assert.ok(capture.entries.some(entry => entry.type === 'regular' && entry.path.endsWith('.lock')));
    }
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('native unknown hold is captured after denied retry before bounded cleanup without TMPDIR', t => {
  const directory = mkdtempSync(join(tmpdir(), 'mam-n8n-build-artifacts-'));
  const sibling = join(directory, 'synthetic-preexisting-held.json');
  writeFileSync(sibling, '{"phase":"HOLD_CREATE_UNKNOWN","synthetic":true}\n', { mode: 0o600 });
  const before = lstatSync(sibling);
  try {
    const result = invoke('native-create-timeout', directory, true);
    t.diagnostic(JSON.stringify({ scenario: 'native-create-timeout-without-TMPDIR', result }));
    assert.equal(result.exit, 2);
    assert.equal(result.retryExit, 2);
    assert.equal(result.journal.phase, 'HOLD_CREATE_UNKNOWN');
    assert.equal(result.native.stickyLock, true);
    assert.equal(result.calls.filter(([method]) => method === 'POST').length, 1);
    const capture = assertTypedCapture(result, directory);
    const journals = capture.entries.filter(entry => entry.type === 'regular' && entry.path.endsWith('.json'));
    assert.ok(journals.length >= 2);
    assert.ok(journals.some(entry => JSON.parse(Buffer.from(entry.contentBase64, 'base64')).phase === 'HOLD_CREATE_UNKNOWN'));
    assert.ok(capture.entries.some(entry => entry.type === 'regular' && entry.path.endsWith('.lock')));
    assert.equal(lstatSync(sibling).ino, before.ino);
    assert.equal(lstatSync(sibling).mode, before.mode);
    assert.equal(readFileSync(sibling, 'utf8'), '{"phase":"HOLD_CREATE_UNKNOWN","synthetic":true}\n');
    assert.deepEqual(readdirSync(directory), ['synthetic-preexisting-held.json']);
    assert.deepEqual(specialArtifacts(QA), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test('native explicit TLS fixture preserves measured verifier and durable CLI stage without environment access', t => {
  const directory = mkdtempSync(join(tmpdir(), 'mam-n8n-build-artifacts-'));
  try {
    const result = invoke('native-cli-stage', directory);
    t.diagnostic(JSON.stringify({ scenario: 'native-cli-stage-explicit-TLS', result }));
    assert.equal(result.exit, 0, result.stderr);
    assert.equal(result.retryExit, null);
    assert.equal(result.native.cliEntered, true);
    assert.equal(result.native.configLoads, 1);
    assert.ok(result.native.compiledVerifier.length > 0);
    assert.ok(result.native.compiledVerifier.every(hash => hash === result.native.expectedVerifierHash));
    assert.equal(result.native.safeRequests, result.calls.length);
    assert.equal(result.calls.length, 4);
    assert.equal(result.calls.filter(([method]) => method === 'POST').length, 1);
    assert.equal(result.journal.phase, 'STAGED_INACTIVE');
    assert.equal(result.native.stickyLock, false);
    assert.equal(result.native.journalMode, '0o600');
    assert.equal(result.native.secretInJournal, false);
    assert.ok(result.native.fsyncs.includes('directory'));
    assert.ok(result.native.fsyncs.includes('file'));
    assertTypedCapture(result, directory);
    assert.deepEqual(readdirSync(directory), []);
    assert.deepEqual(specialArtifacts(QA), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test('native fixture privacy traps reject synthetic credential environment enumeration and socket probes before publisher compilation', t => {
  const directory = mkdtempSync(join(tmpdir(), 'mam-n8n-build-artifacts-'));
  const program = `import io
import json
import os
import socket
import sys
from contextlib import redirect_stdout
from pathlib import Path
root = Path(sys.argv[1])
kind = sys.argv[2]
fixture = root / 'tests/performance-review-n8n-publisher-fixture.py'
target = str(root / 'scripts/publish-performance-review-mail-workflow.py')
probe = {'entered': 0, 'rejected': False, 'code': None, 'beforePublisherCompile': False}
def audit_probe(event, args):
    if event != 'compile' or args[1] != target or probe['entered']:
        return
    probe['entered'] += 1
    probe['beforePublisherCompile'] = True
    try:
        if kind == 'credentialFile':
            with open(root / '.env.local', 'rb'):
                raise AssertionError('UNEXPECTED_CREDENTIAL_OPEN')
        elif kind == 'environment':
            os.environ['SYNTHETIC_FORBIDDEN_KEY']
        elif kind == 'enumeration':
            iter(os.environ)
        elif kind == 'socket':
            socket.socket()
        else:
            raise AssertionError('UNKNOWN_PROBE')
    except AssertionError as error:
        probe['rejected'] = True
        probe['code'] = str(error)
sys.addaudithook(audit_probe)
output = io.StringIO()
with redirect_stdout(output):
    exec(compile(fixture.read_bytes(), str(fixture), 'exec'), {'__file__': str(fixture), '__name__': 'privacy_probe_fixture'})
print(json.dumps({'probe': probe, 'result': json.loads(output.getvalue())}))
`;
  try {
    for (const kind of ['credentialFile', 'environment', 'enumeration', 'socket']) {
      const child = spawnSync('python3', ['-B', '-c', program, ROOT, kind], {
        cwd: ROOT,
        env: { PATH: process.env.PATH, TEMP: directory, LANG: 'C', LC_ALL: 'C' },
        input: JSON.stringify({ argv: ['prepare'] }),
        encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024,
      });
      assert.equal(child.status, 0, child.stderr);
      const { probe, result } = JSON.parse(child.stdout);
      t.diagnostic(JSON.stringify({ kind, probe, forbidden: result.forbidden }));
      assert.deepEqual(probe, {
        entered: 1, rejected: true, beforePublisherCompile: true,
        code: kind === 'credentialFile' ? 'FORBIDDEN_CREDENTIAL_FILE' : kind === 'socket' ? 'FORBIDDEN_SOCKET' : 'FORBIDDEN_ENVIRONMENT',
      });
      assert.equal(result.exit, 0, result.stderr);
      assert.equal(result.missingEntrypoint, false);
      assert.deepEqual(result.forbidden, {
        credentialFile: Number(kind === 'credentialFile'), socket: Number(kind === 'socket'),
        environment: Number(kind === 'environment' || kind === 'enumeration'),
      });
      assert.deepEqual(result.calls, []);
      assert.equal(result.native.configLoads, 0);
      assert.equal(result.native.safeRequests, 0);
    }
    assert.deepEqual(readdirSync(directory), []);
    assert.deepEqual(specialArtifacts(QA), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
