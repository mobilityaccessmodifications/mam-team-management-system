import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fixture, input, lockMessage } from './helpers/password-reset-action-harness.mjs';
const require = createRequire(import.meta.url);

if (process.env.MAM_RESET_FLIGHT === '1') {
  const { renderToPipeableStream } = require('next/dist/compiled/react-server-dom-webpack/server.node');
  renderToPipeableStream({ result: fixture().resetPortalPassword(input) }, {}, { onError: () => 'synthetic-digest' }).pipe(process.stdout);
} else {
  test('credential lock rejection is safe data and never updates Auth or finalises a reset', async () => {
    const f = fixture();
    assert.deepEqual(await f.resetPortalPassword(input), { error: lockMessage });
    assert.deepEqual(f.calls, ['can_manage_portal_accounts','begin_portal_password_reset']);
  });
  test('successful reset claims before changing Auth and finalises once', async () => {
    const f = fixture(null);
    const result = await f.resetPortalPassword(input);
    assert.equal(result.account.userId, input.userId);
    assert.equal(result.oneTimePassword, input.newPassword);
    assert.deepEqual(f.calls, ['can_manage_portal_accounts','begin_portal_password_reset','auth-password-update','finalise_portal_password_reset']);
  });
  test('unrecognised rejection never claims the credential lock or changes Auth', async () => {
    const f = fixture({ code: '55000', message: 'private synthetic other failure' });
    await assert.rejects(f.resetPortalPassword(input), /^Error: The account change could not be saved\. Refresh and try again\.$/);
    assert.deepEqual(f.calls, ['can_manage_portal_accounts','begin_portal_password_reset']);
  });
  for (const outcome of [{ data: { user: null }, error: { message: 'private synthetic timeout' } }, { data: { user: null }, error: null }, new Error('private synthetic lost response')]) {
    test('unconfirmed Auth reset preserves the pending fence without cancellation or retry: '+String(outcome.error?.message ?? outcome.message ?? 'missing user'), async () => {
      const f = fixture(null, outcome);
      assert.deepEqual(await f.resetPortalPassword(input), { error: 'The password-reset result could not be confirmed. Administrator reconciliation is required before trying again.' });
      assert.deepEqual(f.calls, ['can_manage_portal_accounts','begin_portal_password_reset','auth-password-update']);
    });
  }
  test('credential lock rejection survives production Flight without React error redaction', async () => {
    const encoded = spawnSync(process.execPath, ['--conditions=react-server','--input-type=module','-e', "await import('./tests/password-reset-safe-errors.test.mjs')"], {
      encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production', MAM_RESET_FLIGHT: '1' },
    });
    assert.equal(encoded.status,0,encoded.stderr);
    const { createFromNodeStream } = require('next/dist/compiled/react-server-dom-webpack/cjs/react-server-dom-webpack-client.node.production.js');
    const result = await createFromNodeStream(Readable.from([encoded.stdout]), { moduleMap: {}, serverModuleMap: {}, moduleLoading: null });
    assert.deepEqual(await result.result, { error: lockMessage });
    assert.doesNotMatch(encoded.stdout, /private synthetic|synthetic-digest|:E\{/);
  });
}
