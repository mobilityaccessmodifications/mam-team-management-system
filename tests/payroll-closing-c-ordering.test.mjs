import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('closing normalization keeps C ordering and exact corrected source bindings', () => {
  const result = spawnSync('python3', ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_payroll_closing_c_ordering.py', '-v'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran 3 tests/);
  assert.match(result.stderr, /\nOK\n/);
});
