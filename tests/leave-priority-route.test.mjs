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

test('scheduler reaches bearer-auth handler without a browser login; private pages stay protected', async () => {
  const { proxy } = load('src/proxy.ts', {
    '@supabase/ssr': { createServerClient: () => ({ auth: { getClaims: async () => ({ data: { claims: null } }) } }) },
    'next/server': { NextResponse: { next: () => ({ status: 200 }), redirect: () => ({ status: 307 }) } },
    '@/lib/supabase/config': { isSupabaseConfigured: () => true, requireSupabaseConfig: () => ({ supabaseUrl: 'https://example.test', supabasePublishableKey: 'test' }) },
  });
  const request = (pathname) => ({ nextUrl: { pathname, clone: () => new URL(`https://example.test${pathname}`) }, cookies: { getAll: () => [] } });
  assert.equal((await proxy(request('/api/cron/leave-priority-reminders'))).status, 200);
  assert.equal((await proxy(request('/api/cron/leave-accrual'))).status, 200);
  assert.equal((await proxy(request('/'))).status, 307);
  assert.equal((await proxy(request('/api/cron/not-authorised'))).status, 307);
});

test('missing bearer is denied before any database access', async () => {
  const { GET } = load('src/app/api/cron/leave-priority-reminders/route.ts', {
    'node:crypto': require('node:crypto'),
    '@/lib/supabase/admin': { createAdminClient: () => { throw new Error('Database must not be reached'); } },
  });
  assert.equal((await GET(new Request('https://example.test/api/cron/leave-priority-reminders'))).status, 401);
});


test('accrual cron is authenticated, records once and hides database failures', async () => {
  const before = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'synthetic-cron-secret';
  let calls = 0;
  const { GET } = load('src/app/api/cron/leave-accrual/route.ts', {
    'node:crypto': require('node:crypto'),
    '@/lib/supabase/admin': { createAdminClient: () => ({ rpc: async (name) => {
      assert.equal(name, 'refresh_employee_leave_accrual'); calls++;
      return calls === 1 ? { data: 24, error: null } : { data: null, error: { message: 'private-details' } };
    } }) },
  });
  try {
    const url = 'https://example.test/api/cron/leave-accrual';
    assert.equal((await GET(new Request(url))).status, 401);
    assert.equal((await GET(new Request(url, { headers: { authorization: 'Bearer wrong' } }))).status, 401);
    assert.equal(calls, 0);
    const good = () => new Request(url, { headers: { authorization: 'Bearer synthetic-cron-secret' } });
    assert.deepEqual(await (await GET(good())).json(), { ok: true, recorded: 24 });
    const failure = await GET(good());
    assert.equal(failure.status, 500);
    assert.doesNotMatch(await failure.text(), /private-details/);
  } finally {
    if (before === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = before;
  }
});
