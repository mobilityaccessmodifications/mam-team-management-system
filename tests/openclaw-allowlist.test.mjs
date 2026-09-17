import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
function load(file, imports) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loadedModule = { exports: {} };
  new Function('require', 'module', 'exports', code)((id) => {
    if (id in imports) return imports[id];
    throw new Error(`Unexpected import: ${id}`);
  }, loadedModule, loadedModule.exports);
  return loadedModule.exports;
}
const lib = load('src/lib/openclaw-allowlist.ts', { 'server-only': {}, 'node:crypto': require('node:crypto') });
const url = 'https://example.test/api/internal/integrations/openclaw/whatsapp-allowlist';
const secret = 'synthetic-only-test-key-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const envelope = (phones) => ({ schemaVersion: 1, complete: true, rowCount: phones.length, phones });
const request = (header = `Bearer ${secret}`, suffix = '') => new Request(url + suffix, { headers: { authorization: header } });

test('dedicated authentication rejects missing, wrong, oversized and malformed tokens', () => {
  for (const header of ['', 'Basic ' + secret, 'Bearer wrong', `Bearer ${secret}x`, 'Bearer ' + 'a'.repeat(129), `Bearer ${secret},other`]) {
    assert.equal(lib.allowlistAuthorization(request(header), secret), 401);
  }
  for (const value of [undefined, '', 'short', 'contains space'.repeat(8)]) {
    assert.equal(lib.allowlistAuthorization(request(), value), 503);
  }
  assert.equal(lib.allowlistAuthorization(request(), secret), 200);
});

test('normalization excludes missing, ambiguous and invalid phones; shared phones fail closed', () => {
  const raw = ['+61 400 000 001', '+61-400-000-002', '+61400000002', null, '', '0400000003', '+61 (0)400000003', '+61400000003 ext 1', '+01400000003', '+123', '+1234567890123456', '0044400000000', '+61400000003/+61400000004'];
  assert.deepEqual(lib.allowlistSnapshot(envelope(raw), '2026-09-17T00:00:00.000Z').phones, ['+61400000001']);
});

test('metadata is minimal and digest stable across input order, formatting and generation time', () => {
  const first = lib.allowlistSnapshot(envelope(['+61400000002', '+61 400 000 001']), '2026-09-17T00:00:00.000Z');
  const second = lib.allowlistSnapshot(envelope(['+61400000001', '+61400000002']), '2026-09-17T00:00:01.000Z');
  assert.deepEqual(Object.keys(first).sort(), ['digest', 'generatedAt', 'phones', 'schemaVersion']);
  assert.equal(first.digest, second.digest);
  assert.match(first.digest, /^[a-f0-9]{64}$/);
  assert.notEqual(first.digest, lib.allowlistSnapshot(envelope([]), first.generatedAt).digest);
  assert.deepEqual(lib.allowlistSnapshot(envelope([]), first.generatedAt).phones, []);
});

test('null, partial, malformed, unexpected or oversized snapshots are never success-shaped empties', () => {
  for (const data of [null, [], {}, { ...envelope([]), complete: false }, { ...envelope([]), rowCount: 1 }, { ...envelope([]), schemaVersion: 2 }, envelope([123]), { ...envelope([]), name: 'private' }, envelope(Array(10001).fill(null))]) {
    assert.throws(() => lib.allowlistSnapshot(data, '2026-09-17T00:00:00.000Z'));
  }
});

test('route authorizes before database access, bounds reads and never leaks failures', async () => {
  const previous = process.env.MAM_OPENCLAW_ALLOWLIST_SECRET;
  process.env.MAM_OPENCLAW_ALLOWLIST_SECRET = secret;
  let calls = 0;
  let result = { data: envelope(['+61400000001']), error: null };
  const { GET } = load('src/app/api/internal/integrations/openclaw/whatsapp-allowlist/route.ts', {
    '@/lib/openclaw-allowlist': lib,
    '@/lib/supabase/admin': { createAdminClient: () => ({ rpc: (name) => {
      calls++;
      assert.equal(name, 'openclaw_whatsapp_allowlist_snapshot');
      return { abortSignal: async (signal) => { assert.ok(signal instanceof AbortSignal); if (result instanceof Error) throw result; return result; } };
    } }) },
  });
  try {
    assert.equal((await GET(request(''))).status, 401);
    assert.equal((await GET(request(undefined, '?limit=0'))).status, 400);
    assert.equal(calls, 0);
    const success = await GET(request());
    assert.equal(success.status, 200);
    assert.match(success.headers.get('cache-control'), /no-store/);
    assert.equal(success.headers.get('access-control-allow-origin'), null);
    const body = await success.json();
    assert.deepEqual(body.phones, ['+61400000001']);
    assert.ok(Number.isFinite(Date.parse(body.generatedAt)));
    for (const failure of [{ data: null, error: null }, { data: envelope([]), error: { message: 'private DB error' } }, { data: { ...envelope([]), rowCount: 2 }, error: null }, new Error('secret failure')]) {
      result = failure;
      const response = await GET(request());
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { code: 'unavailable' });
    }
    result = { data: envelope([]), error: null };
    assert.deepEqual((await (await GET(request())).json()).phones, []);
    delete process.env.MAM_OPENCLAW_ALLOWLIST_SECRET;
    assert.equal((await GET(request())).status, 503);
  } finally {
    if (previous === undefined) delete process.env.MAM_OPENCLAW_ALLOWLIST_SECRET;
    else process.env.MAM_OPENCLAW_ALLOWLIST_SECRET = previous;
  }
});

test('only exact integration path bypasses browser auth, even without Supabase config', async () => {
  const { proxy } = load('src/proxy.ts', {
    '@supabase/ssr': { createServerClient: () => { throw new Error('must not refresh cookies'); } },
    'next/server': { NextResponse: { next: () => ({ status: 200 }), redirect: () => ({ status: 307 }) } },
    '@/lib/supabase/config': { isSupabaseConfigured: () => false },
  });
  const input = (path) => ({ nextUrl: { pathname: path, clone: () => new URL('https://example.test' + path) } });
  assert.equal((await proxy(input(new URL(url).pathname))).status, 200);
  for (const path of ['/', '/api/internal/integrations/openclaw/other', new URL(url).pathname + '/extra']) {
    assert.equal((await proxy(input(path))).status, 307);
  }
});
