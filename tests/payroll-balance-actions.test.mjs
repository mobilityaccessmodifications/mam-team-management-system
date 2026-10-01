import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const personId = '96000000-0000-4000-8000-000000000002';
export function loadBalanceActions({ dbError = null, revalidateError = false, authenticated = true } = {}) {
  const calls = [], exports = {};
  new Function('exports', 'require', ts.transpileModule(readFileSync('src/app/leave/actions.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(exports, id => ({
    'next/cache': { revalidatePath() { if (revalidateError) throw new Error('private refresh detail'); } },
    'next/server': {}, '@/lib/supabase/admin': {}, '@/lib/leave-notification-outbox': {},
    '@/lib/supabase/server': { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: authenticated ? { id: personId } : null }, error: null }) }, rpc: async (name, args) => { calls.push({ name, args }); return { error: dbError }; } }) },
    '@/lib/leave-priority': {}, '@/lib/leave-notice': {}, '@/lib/leave-date-range': {}, '@/lib/leave-request-balance': {},
  })[id] ?? require(id));
  return { actions: exports, calls };
}
const guard = { code: '55000', message: 'Use audited payroll reconciliation for retained commitments.', details: 'private leave detail' };
const guarded = 'This balance has retained payroll commitments. Use the audited closing reconciliation or settlement operation.';
const methodInput = method => method === 'saveAnnualLeaveBalance' ? [personId, 100, '2026-09-25', false] : [personId, 100, '2026-09-25'];
if (process.env.MAM_BALANCE_FLIGHT === '1') {
  require('next/dist/compiled/react-server-dom-webpack/server.node').renderToPipeableStream({
    denied: loadBalanceActions({ dbError: guard }).actions.saveAnnualLeaveBalance(...methodInput('saveAnnualLeaveBalance')),
    committed: loadBalanceActions({ revalidateError: true }).actions.saveSickLeaveBalance(...methodInput('saveSickLeaveBalance')),
    auth: loadBalanceActions({ authenticated: false }).actions.saveAnnualLeaveBalance(...methodInput('saveAnnualLeaveBalance')),
  }, {}, { onError: () => 'unexpected-digest' }).pipe(process.stdout);
} else {
  test('real balance actions reject retained commitments as allowlisted serializable outcomes', async () => {
    for (const method of ['saveAnnualLeaveBalance', 'saveSickLeaveBalance']) {
      const { actions, calls } = loadBalanceActions({ dbError: guard });
      assert.deepEqual(await actions[method](...methodInput(method)), { ok: false, committed: false, message: guarded });
      assert.equal(calls.length, 1);
      assert.doesNotMatch(JSON.stringify(await loadBalanceActions({ dbError: { code: 'XX000', message: 'private provider secret' } }).actions[method](...methodInput(method))), /private|secret/);
    }
  });
  test('successful balance write followed by failed revalidation remains committed and cannot invite retry', async () => {
    for (const method of ['saveAnnualLeaveBalance', 'saveSickLeaveBalance']) {
      const { actions, calls } = loadBalanceActions({ revalidateError: true });
      assert.deepEqual(await actions[method](...methodInput(method)), { ok: false, committed: true, message: 'Balance was saved. Refresh before trying again.' });
      assert.equal(calls.length, 1);
    }
  });
  test('production Flight preserves guarded and committed results without provider errors or digests', async () => {
    const wire = spawnSync(process.execPath, ['--conditions=react-server', '--input-type=module', '-e', "await import('./tests/payroll-balance-actions.test.mjs')"], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production', MAM_BALANCE_FLIGHT: '1' } });
    assert.equal(wire.status, 0, wire.stderr);
    const output = await require('next/dist/compiled/react-server-dom-webpack/cjs/react-server-dom-webpack-client.node.production.js').createFromNodeStream(Readable.from([wire.stdout]), { moduleMap: {}, serverModuleMap: {}, moduleLoading: null });
    assert.deepEqual(await output.denied, { ok: false, committed: false, message: guarded });
    assert.equal((await output.committed).committed, true);
    assert.equal((await output.auth).ok, false);
    assert.doesNotMatch(wire.stdout, /:E\{|unexpected-digest|private/);
  });
}
