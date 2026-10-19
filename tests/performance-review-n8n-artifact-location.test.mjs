import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const FIXTURE = join(ROOT, 'tests/performance-review-n8n-repair-fixture.py');
const bootstrap = String.raw`import hashlib
import json
import os
from pathlib import Path
import sys
fixture = Path(sys.argv[1])
expected = sys.argv[2]
allowed = Path(sys.argv[3]).resolve()
arguments = json.loads(sys.argv[4])
root = fixture.resolve().parents[1]
observed = {'writes': [], 'denied': [], 'compiled': [], 'forbidden': {'credential': 0, 'environment': 0, 'network': 0}}
directories = {}
opening = []
original_open = os.open
def resolve_path(path, directory=None):
    path = Path(os.fsdecode(path))
    if not path.is_absolute() and directory is not None and directory != -1:
        assert directory in directories, 'UNKNOWN_FIXTURE_DIRECTORY_FD'
        path = directories[directory] / path
    return path.resolve()
def tracked_open(path, flags, mode=0o777, *, dir_fd=None):
    resolved = resolve_path(path, dir_fd)
    opening.append(resolved)
    try:
        fd = original_open(path, flags, mode, dir_fd=dir_fd)
    finally:
        opening.pop()
    if os.fstat(fd).st_mode & 0o170000 == 0o040000:
        directories[fd] = resolved
    return fd
os.open = tracked_open
def audit(event, args):
    if event == 'open' and isinstance(args[0], (str, bytes)):
        path = Path(os.fsdecode(args[0]))
        if path.name.startswith('.env') or path.name == '.npmrc' or '/.ssh/' in str(path) or 'Keychains' in str(path):
            observed['forbidden']['credential'] += 1
            raise AssertionError('FORBIDDEN_CREDENTIAL_FILE')
        if args[2] & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
            paths = [opening[-1] if opening else resolve_path(path)]
        else:
            paths = []
    elif event in ('os.mkdir', 'os.remove', 'os.rmdir'):
        paths = [resolve_path(args[0], args[2] if event == 'os.mkdir' else args[1])]
    elif event == 'os.rename':
        paths = [resolve_path(args[0], args[2]), resolve_path(args[1], args[3])]
    elif event in ('os.symlink', 'os.link'):
        paths = [resolve_path(args[0]), resolve_path(args[1])]
    else:
        paths = []
    for path in paths:
        resolved = path.resolve()
        if resolved == root or root in resolved.parents or not (resolved == allowed or allowed in resolved.parents):
            observed['denied'].append({'event': event, 'path': str(resolved)})
            raise AssertionError('FIXTURE_OUTPUT_SCOPE_DENIED')
        observed['writes'].append({'event': event, 'path': str(resolved)})
    if event.startswith('socket.'):
        observed['forbidden']['network'] += 1
        raise AssertionError('FORBIDDEN_SOCKET')
    if event == 'compile' and isinstance(args[0], bytes):
        observed['compiled'].append({'path': args[1], 'sha256': hashlib.sha256(args[0]).hexdigest()})
class EnvironmentTrap:
    def __getitem__(self, key):
        observed['forbidden']['environment'] += 1
        raise AssertionError('FORBIDDEN_ENVIRONMENT')
    get = __getitem__
    def __iter__(self):
        observed['forbidden']['environment'] += 1
        raise AssertionError('FORBIDDEN_ENVIRONMENT')
sys.addaudithook(audit)
os.environ = EnvironmentTrap()
raw = fixture.read_bytes()
assert hashlib.sha256(raw).hexdigest() == expected
sys.argv = [str(fixture), *arguments]
try:
    exec(compile(raw, str(fixture), 'exec'), {'__name__': '__main__', '__file__': str(fixture)})
finally:
    print('FIXTURE_OUTPUT_OBSERVATIONS ' + json.dumps(observed), file=sys.stderr)
`;

function invoke(arguments_, allowed, capture, name) {
  const fixtureHash = createHash('sha256').update(readFileSync(FIXTURE)).digest('hex');
  const args = ['-B', '-c', bootstrap, FIXTURE, fixtureHash, allowed, JSON.stringify(arguments_)];
  const child = spawnSync('/usr/bin/python3', args, {
    cwd: ROOT, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024,
  });
  writeFileSync(join(capture, `${name}.stdout`), child.stdout || '');
  writeFileSync(join(capture, `${name}.stderr`), child.stderr || '');
  writeFileSync(join(capture, `${name}.exit.json`), JSON.stringify({
    command: ['/usr/bin/python3', ...args], exit: child.status, signal: child.signal,
    fixtureHash, error: child.error?.code || null,
  }) + '\n');
  const lines = (child.stderr || '').split('\n').filter(line => line.startsWith('FIXTURE_OUTPUT_OBSERVATIONS '));
  assert.equal(lines.length, 1, child.stderr);
  const observed = JSON.parse(lines[0].slice('FIXTURE_OUTPUT_OBSERVATIONS '.length));
  assert.ok(observed.compiled.some(entry => entry.path === FIXTURE && entry.sha256 === fixtureHash));
  assert.deepEqual(observed.forbidden, { credential: 0, environment: 0, network: 0 });
  return { child, observed };
}

function regularArtifacts(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const info = lstatSync(path);
    if (info.isDirectory()) files.push(...regularArtifacts(path));
    else {
      assert.equal(info.isFile(), true, path);
      files.push(path);
    }
  }
  return files;
}

test('actual repair fixture keeps its public control and all artifacts inside a private child of supplied shared scratch', t => {
  const capture = mkdtempSync(join(tmpdir(), 'performance-review-n8n-artifact-location-'));
  const base = join(capture, 'shared-base');
  mkdirSync(base);
  chmodSync(base, 0o1777);
  const { child, observed } = invoke(['control', base], base, capture, 'control');
  t.diagnostic(JSON.stringify({ capture, denied: observed.denied }));
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(observed.denied, []);
  const result = JSON.parse(child.stdout);
  assert.deepEqual(result.steps.map(step => step.exit), [0, 0]);
  assert.equal(result.metrics.mainDefaultEntrances, 2);
  assert.ok(result.metrics.compiledVerifier.length > 0);
  assert.deepEqual(result.forbidden, { credentialFile: 0, socket: 0, environment: 0, privateSource: 0 });
  assert.equal(result.actualEmails, 0);
  assert.equal(result.actualStageAllowed, false);
  assert.equal(result.actualActivateAllowed, false);
  assert.equal(dirname(dirname(result.namespace)), realpathSync(base));
  assert.equal(lstatSync(dirname(result.namespace)).mode & 0o777, 0o700);
  assert.equal(lstatSync(result.namespace).mode & 0o777, 0o700);
  assert.match(readFileSync(join(result.namespace, 'SYNTHETIC_ONLY'), 'utf8'), /^INERT OWNED NAMESPACE;/);
  const files = regularArtifacts(realpathSync(base));
  assert.ok(files.includes(join(result.namespace, 'result.json')));
  assert.ok(files.length > 1);
  assert.ok(observed.writes.length > 0);
  assert.ok(observed.compiled.some(entry => entry.path === join(ROOT, 'scripts/publish-performance-review-mail-workflow.py') && entry.sha256 === result.sourceSha256));
});

test('actual repair fixture safely rejects invalid output arguments before any mkdir or product compile', t => {
  const capture = mkdtempSync(join(tmpdir(), 'performance-review-n8n-artifact-location-'));
  const file = join(capture, 'not-a-directory');
  writeFileSync(file, 'SYNTHETIC_ONLY\n');
  const alias = join(capture, 'root-alias');
  symlinkSync(ROOT, alias, 'dir');
  const inputs = [
    ['missing', ['control']],
    ['empty', ['control', '']],
    ['relative', ['control', '.']],
    ['absent', ['control', join(capture, 'absent')]],
    ['file', ['control', file]],
    ['root', ['control', ROOT]],
    ['traversal', ['control', `${ROOT}/tests/..`]],
    ['symlink', ['control', alias]],
    ['descendant', ['control', join(ROOT, 'tests')]],
    ['case-escape', [ROOT, capture]],
  ];
  for (const [name, args] of inputs) {
    const { child, observed } = invoke(args, capture, capture, name);
    assert.equal(child.status, 2, child.stderr);
    assert.equal(child.stdout, '');
    assert.equal(child.stderr.split('\n')[0], 'INVALID_FIXTURE_OUTPUT');
    assert.deepEqual(observed.writes, []);
    assert.deepEqual(observed.denied, []);
    assert.equal(observed.compiled.some(entry => entry.path === join(ROOT, 'scripts/publish-performance-review-mail-workflow.py')), false);
  }
  t.diagnostic(JSON.stringify({ capture, rejectedInputs: inputs.map(([name]) => name) }));
});
