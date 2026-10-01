import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { target } from '../scripts/local-test-postgres.mjs';

test('task-owned PostgreSQL sockets support the configured scratch directory', () => {
  const socket = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'mam-openclaw-pg.')));
  try {
    writeFileSync(path.join(socket, 'mam-test-cluster.json'), JSON.stringify({ owner: 'mam-local-tests-v1', socket, port: 55439 }));
    assert.equal(target(socket, 'mam_test_scratch')[2], socket);
    assert.throws(() => target(socket, 'production'), /synthetic test database/);
    assert.throws(() => target(path.dirname(socket), 'mam_test_scratch'), /task-owned/);
  } finally {
    rmSync(socket, { recursive: true });
  }
});
