import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { loadUatSafety } from './helpers/uat-safety-loader.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const projectUrl = 'https://xtwlrjqbusadghavchqm.supabase.co';
const cookieName = 'sb-xtwlrjqbusadghavchqm-auth-token';
// All authentication material in this test is synthetic, never a real session.
const fixtureToken = (payload) => `${Buffer.from('{"alg":"RS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(payload).toString('base64url')}.syntheticSignature`;
const token = fixtureToken('{"iat":100,"exp":200,"sub":"synthetic-only"}');
const cookie = JSON.stringify({ access_token: token, refresh_token: 'never-use-this-fixture' });
function load(file, imports = {}) {
  if (!existsSync(file)) return {};
  const source = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', source)(
    (id) => id === '@/lib/uat-safety' ? loadUatSafety() : id in imports ? imports[id] : require(id), mod, mod.exports,
  );
  return mod.exports;
}
function proofModule() {
  return load('src/lib/operator-session-proof.ts', {
    'server-only': {},
    '@/lib/supabase/config': { requireSupabaseConfig: () => ({ supabaseUrl: projectUrl, supabasePublishableKey: 'synthetic-publishable' }) },

  });
}

test('existing cookie reaches only the fixed read-only RPC and returns a literal Boolean', async () => {
  const { verifyOperatorSession } = proofModule();
  assert.equal(typeof verifyOperatorSession, 'function', 'the no-refresh proof component is not implemented');
  const calls = [];
  const result = await verifyOperatorSession(`unrelated=value; ${cookieName}=${encodeURIComponent(cookie)}`, async (url, options) => {
    calls.push({ url, options });
    return Response.json(true);
  });
  assert.equal(result, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${projectUrl}/rest/v1/rpc/verify_current_payroll_operator_session`);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[0].options.headers.apikey, 'synthetic-publishable');
  assert.equal(calls[0].options.body, undefined);
});

test('the exact proof route bypasses cookie-refresh middleware before any Auth client is created', async () => {
  let created = 0;
  const { proxy } = load('src/proxy.ts', {
    '@supabase/ssr': { createServerClient: () => { created++; throw new Error('refresh is forbidden'); } },
    'next/server': { NextResponse: { next: () => ({ status: 200 }), redirect: () => ({ status: 307 }) } },
    '@/lib/asset-qr': { assetLoginReturnPath: () => null },
    '@/lib/supabase/config': { isSupabaseConfigured: () => true, requireSupabaseConfig: () => ({ supabaseUrl: projectUrl, supabasePublishableKey: 'synthetic-publishable' }) },
  });
  const request = { nextUrl: { pathname: '/api/internal/payroll/session-proof' } };
  await assert.doesNotReject(async () => {
    assert.equal((await proxy(request)).status, 200);
  }, 'the proof route must never construct the refresh-capable SDK');
  assert.equal(created, 0);
});

test('the HTTP route returns only a no-store Boolean without writing cookies', async () => {
  const seen = [];
  const { GET } = load('src/app/api/internal/payroll/session-proof/route.ts', {
    '@/lib/operator-session-proof': { verifyOperatorSession: async (header) => { seen.push(header); return true; } },
  });
  assert.equal(typeof GET, 'function', 'the Boolean-only HTTP route is not implemented');
  const response = await GET(new Request('https://synthetic.example/api/internal/payroll/session-proof', { headers: { cookie: 'synthetic=value' } }));
  assert.equal(await response.text(), 'true');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.headers.get('vary'), 'Cookie');
  assert.deepEqual(seen, ['synthetic=value']);
});

test('integer claim lexemes cannot be replaced by floats or exponent notation during gateway parsing', async () => {
  const { verifyOperatorSession } = proofModule();
  for (const payload of ['{"iat":1e2,"exp":200}', '{"iat":100.0,"exp":200}', '{"iat":100,"exp":2e2}', '{"iat":"100","exp":200}']) {
    let calls = 0;
    const stored = JSON.stringify({ access_token: fixtureToken(payload) });
    assert.equal(await verifyOperatorSession(`${cookieName}=${encodeURIComponent(stored)}`, async () => { calls++; return Response.json(true); }), false);
    assert.equal(calls, 0, 'non-integer original claim types must be rejected before transport');
  }
});

test('the installed SSR base64 and contiguous cookie chunks keep the existing bearer unchanged', async () => {
  const { verifyOperatorSession } = proofModule();
  const stored = `base64-${Buffer.from(cookie).toString('base64url')}`;
  const chunks = [stored.slice(0, 35), stored.slice(35, 80), stored.slice(80)];
  const header = chunks.map((value, index) => `${cookieName}.${index}=${encodeURIComponent(value)}`).reverse().join('; ');
  let calls = 0;
  assert.equal(await verifyOperatorSession(header, async (url, options) => {
    calls++;
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    return Response.json(true);
  }), true);
  assert.equal(calls, 1);
});

test('missing, duplicate, ambiguous, malformed and oversized cookies deny before any provider call', async () => {
  const { verifyOperatorSession } = proofModule();
  const valid = `${cookieName}=${encodeURIComponent(cookie)}`;
  const invalid = [null, '', 'unrelated=value', `${valid}; ${valid}`, `${valid}; ${cookieName}.0=value`,
    `${cookieName}.1=value`, `${cookieName}.00=value`, `${cookieName}=%`, `${cookieName}=base64-%%%`,
    `${cookieName}=${encodeURIComponent('[]')}`, `${cookieName}=${encodeURIComponent('{"refresh_token":"synthetic-only"}')}`,
    `${cookieName}=${encodeURIComponent('{"access_token":"not-a-jws"}')}`, 'x'.repeat(65537)];
  for (const header of invalid) {
    let calls = 0;
    assert.equal(await verifyOperatorSession(header, async () => { calls++; return Response.json(true); }), false);
    assert.equal(calls, 0);
  }
});

test('provider denials, non-Boolean payloads and transport errors deny with no retries', async () => {
  const { verifyOperatorSession } = proofModule();
  const responses = [() => new Response('true', { status: 401 }), () => new Response('true', { status: 500 }),
    () => Response.json(false), () => Response.json('true'), () => Response.json([true]),
    () => Response.json({ verified: true }), () => new Response('invalid json'),
    () => { throw new Error('synthetic transport error'); }];
  for (const result of responses) {
    let calls = 0;
    assert.equal(await verifyOperatorSession(`${cookieName}=${encodeURIComponent(cookie)}`, async () => { calls++; return result(); }), false);
    assert.equal(calls, 1);
  }
});

test('only top-level unique integer time claims are accepted by the in-runtime type check', async () => {
  const { verifyOperatorSession } = proofModule();
  const examples = [
    ['{"metadata":{"iat":100,"exp":200}}', false],
    ['{"iat":100,"iat":100,"exp":200}', false],
    ['{"iat":100,"exp":200,"metadata":{"iat":1e2,"text":"a\\\"b{}"}}', true],
    ['{"\\u0069at":100,"exp":200}', true],
    ['{"iat":null,"exp":200}', false], ['{"iat":true,"exp":200}', false],
  ];
  for (const [payload, expected] of examples) {
    let calls = 0;
    const header = `${cookieName}=${encodeURIComponent(JSON.stringify({ access_token: fixtureToken(payload) }))}`;
    assert.equal(await verifyOperatorSession(header, async () => { calls++; return Response.json(true); }), expected);
    assert.equal(calls, Number(expected));
  }
});
