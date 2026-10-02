import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('diagnostic release preserves pinned guards and requires an exact reviewed query', () => {
  const result = spawnSync('python3', ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_payroll_closing_diagnostic.py', '-v'], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1_048_576,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 5 tests/);
  assert.match(result.stderr, /\nOK\n/);
});
