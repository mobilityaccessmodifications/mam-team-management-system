import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../scripts/local-test-postgres.mjs', import.meta.url));
const rehearsal = fileURLToPath(new URL('./run-subscription-review-release.py', import.meta.url));
const preflight = String.raw`
import json, os, runpy, subprocess, sys

def stop_at_git(args, **kwargs):
    assert len(args) == 5 and args[0] == 'git' and args[1] == '-C' and args[3:] == ['init', '--quiet']
    print(json.dumps({'TMPDIR': os.environ['TMPDIR'], 'boundary': 'git init'}))
    raise SystemExit(0)

subprocess.run = stop_at_git
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name='__main__')
`;
const caller = String.raw`
const [helper, preflight, rehearsal, socket] = process.argv.slice(1);
process.argv[1] = process.execPath;
const { command } = await import(helper);
process.stdout.write(command('python3', ['-B', '-c', preflight, rehearsal, socket, 'mam_test_tmpdir']));
`;

function fixture(run) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'mam-temp-root-')));
  const socket = realpathSync(mkdtempSync(path.join(root, 'mam-openclaw-pg.')));
  writeFileSync(path.join(socket, 'mam-test-cluster.json'), JSON.stringify({ owner: 'mam-local-tests-v1', socket, port: 55439 }));
  try {
    run(root, socket);
  } finally {
    rmSync(root, { recursive: true });
  }
}

function invoke(root, socket, tmpdir) {
  const env = { PATH: process.env.PATH, TMP: root, TEMP: root, LANG: 'C', LC_ALL: 'C' };
  if (tmpdir !== undefined) env.TMPDIR = tmpdir;
  return spawnSync(process.execPath, ['--input-type=module', '-e', caller, helper, preflight, rehearsal, socket], { env, encoding: 'utf8' });
}

test('PostgreSQL caller supplies its trusted temporary root when TMPDIR is absent', () => {
  fixture((root, socket) => {
    const result = invoke(root, socket);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { TMPDIR: root, boundary: 'git init' });
  });
});

test('PostgreSQL caller preserves the explicitly configured temporary root', () => {
  fixture((root, socket) => {
    const result = invoke(root, socket, root + path.sep);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { TMPDIR: root, boundary: 'git init' });
  });
});

test('subscription review rehearsal denies a socket outside the trusted temporary root', () => {
  fixture((root, socket) => {
    const result = invoke(root, socket, path.dirname(root));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /run-subscription-review-release\.py/);
    assert.match(result.stderr, /AssertionError/);
    assert.doesNotMatch(result.stderr, /KeyError/);
    assert.equal(result.stdout, '');
  });
});
