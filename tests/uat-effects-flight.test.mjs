import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import test from 'node:test';
import { ROOT, UNAVAILABLE } from './uat-effects-fixtures.mjs';

const require = createRequire(import.meta.url);
test('production Flight transports all 11 actual UAT mutation rejections as data without RSC error redaction', async () => {
  const child = spawnSync(process.execPath, ['--conditions=react-server', 'tests/uat-effects-flight-fixture.mjs'], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: 'C', LC_ALL: 'C', NODE_ENV: 'production' },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  assert.doesNotMatch(child.stdout, /synthetic-flight-error|:E\{|digest/);
  const { createFromNodeStream } = require('next/dist/compiled/react-server-dom-webpack/cjs/react-server-dom-webpack-client.node.production.js');
  const model = await createFromNodeStream(Readable.from([child.stdout]), { moduleMap: {}, serverModuleMap: {}, moduleLoading: null });
  const expected = {};
  for (const name of ['createPortalAccount', 'updatePortalLogin', 'resetPortalPassword', 'togglePortalAccount', 'createEmployeeDirectoryRecord', 'updateEmployeeDirectoryRecord', 'updateEmployeeDirectoryRole']) expected[name] = { error: UNAVAILABLE };
  for (const name of ['archiveEmployeeDirectoryRecord', 'deleteEmployeeDirectoryRecord']) expected[name] = { ok: false, message: UNAVAILABLE };
  for (const name of ['requestPasswordRecovery', 'resetRecoveredPassword']) expected[name] = { status: 'error', message: 'Password reset is unavailable. Try again later.' };
  assert.deepEqual(model, expected);
});
