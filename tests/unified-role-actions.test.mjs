import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import test from 'node:test';
import { actionFixture, capabilities, requireAction, targetId } from './helpers/unified-role-harness.mjs';
const require = createRequire(import.meta.url);
const safeError = { ok: false, error: 'Role permissions could not be loaded. Retry before using this profile.' };
const run = f => requireAction(f.load('src/app/roles/actions.ts'), 'getPortalRoleCapabilities');
if (process.env.MAM_ROLE_FLIGHT === '1') {
  const f = actionFixture({ error: { message: 'private synthetic database detail' } });
  require('next/dist/compiled/react-server-dom-webpack/server.node').renderToPipeableStream({ result: run(f)(targetId) }, {}, { onError: () => 'synthetic-digest' }).pipe(process.stdout);
} else {
  test('canonical capability action returns exactly one validated target row without contacts or supplied actor', async () => {
    const f = actionFixture();
    const result = await run(f)(targetId);
    assert.deepEqual(result, { ok: true, capabilities: capabilities() });
    assert.ok(f.calls.some(call => call.name === 'get_portal_role_capabilities' && call.args.p_person_id === targetId));
    assert.ok(!f.calls.some(call => /profile_for_hr|access_role_for_preview/.test(call.name)));
    assert.ok(f.calls.every(call => !Object.hasOwn(call.args ?? {}, 'p_actor_id')));
  });
  test('canonical capability failures are retryable safe data, never a Team member fallback', async () => {
    for (const options of [{ error: { message: 'private synthetic database detail' } }, { target: { ...capabilities(), app_role: 'hr' } }, { target: { ...capabilities(), can_manage_assets: 'true' } }, { target: { ...capabilities(), person_id: null } }, { target: { ...capabilities(), account_status: 'disabled' } }, { session: false }]) {
      const f = actionFixture(options);
      assert.deepEqual(await run(f)(targetId), safeError);
    }
  });
  test('ordinary Admin cannot request target capabilities; current authority uses the NULL contract', async () => {
    const f = actionFixture({ actor: capabilities('admin') });
    assert.deepEqual(await run(f)(targetId), safeError);
    assert.ok(!f.calls.some(call => call.args?.p_person_id === targetId));
    const own = actionFixture({ actor: capabilities('account') });
    assert.deepEqual(await run(own)(), { ok: true, capabilities: capabilities('account') });
    assert.deepEqual(own.calls, [{ name: 'get_portal_role_capabilities', args: { p_person_id: null } }]);
  });
  test('private contact profile loading does not fetch or reinterpret role capabilities', async () => {
    const f = actionFixture();
    const result = await f.load('src/app/profile/actions.ts').getSelectedEmployeeProfile(targetId);
    assert.equal(result.personId, targetId);
    assert.ok(!f.calls.some(call => call.name === 'get_selected_employee_profile_access_role_for_preview'));
    assert.equal(Object.hasOwn(result, 'accessRole'), false);
  });
  test('capability failure survives real production Flight as sanitized retryable data', async () => {
    const encoded = spawnSync(process.execPath, ['--conditions=react-server','--input-type=module','-e', "await import('./tests/unified-role-actions.test.mjs')"], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production', MAM_ROLE_FLIGHT: '1' } });
    assert.equal(encoded.status, 0, encoded.stderr);
    const { createFromNodeStream } = require('next/dist/compiled/react-server-dom-webpack/cjs/react-server-dom-webpack-client.node.production.js');
    const result = await createFromNodeStream(Readable.from([encoded.stdout]), { moduleMap: {}, serverModuleMap: {}, moduleLoading: null });
    assert.deepEqual(await result.result, safeError);
    assert.doesNotMatch(encoded.stdout, /private synthetic|synthetic-digest|:E\{/);
  });
}
