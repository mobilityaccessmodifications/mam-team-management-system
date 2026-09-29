import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const personId = '10000000-0000-4000-8000-000000000001';
const userId = '10000000-0000-4000-8000-000000000002';
const claimToken = '10000000-0000-4000-8000-000000000003';
const deliveryId = '10000000-0000-4000-8000-000000000004';
const ok = (data) => ({ data, error: null });
function load(source, dependencies) {
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', ts.transpileModule(readFileSync(source, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)((id) => dependencies[id] ?? require(id), mod, mod.exports);
  return mod.exports;
}
function routeFixture(options = {}) {
  const calls = [];
  let payload;
  const admin = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === 'claim_due_onboarding_credentials') return ok([{ delivery_id: deliveryId, claim_token: claimToken, person_id: personId, auth_user_id: userId, login_name: 'work@example.test', work_email: 'work@example.test', personal_email: 'home@example.test' }]);
      if (name === 'begin_onboarding_credential_delivery') return ok(options.stale ? false : true);
      if (name === 'complete_onboarding_credential_delivery') return ok(true);
      if (name === 'fail_onboarding_credential_delivery') return ok(true);
      throw new Error(`Unexpected RPC ${name}`);
    },
    auth: { admin: { updateUserById: async (_id, change) => { assert.equal(_id, userId); assert.match(change.password, /^.{20,}$/); return options.updateFailed ? { error: { message: 'rejected' } } : ok({ user: { id: userId } }); } } },
  };
  const originalFetch = globalThis.fetch;
  const previous = { ...process.env };
  Object.assign(process.env, { CRON_SECRET: 'synthetic-cron', ONBOARDING_CREDENTIAL_WEBHOOK_ORIGIN: 'https://n8n.example.test', ONBOARDING_CREDENTIAL_WEBHOOK_URL: 'https://n8n.example.test/webhook/mam-people-hub-onboarding-credentials-v1', ONBOARDING_CREDENTIAL_WEBHOOK_SECRET: 'synthetic-secret', ONBOARDING_CREDENTIAL_EMAIL_MODE: 'live' });
  globalThis.fetch = async (_url, fetchOptions) => {
    payload = JSON.parse(fetchOptions.body);
    if (options.throwOnFetch || fetchOptions.signal?.aborted) throw new Error('failed');
    return Response.json(options.badAcknowledgement ? { ok: false, deliveryId: payload.deliveryId } : { ok: true, sent: true, deliveryId: payload.deliveryId });
  };
  const route = load('src/app/api/cron/onboarding-credentials/route.ts', { '@/lib/supabase/admin': { createAdminClient: () => admin } });
  return { route, calls, get payload() { return payload; }, cleanup() { globalThis.fetch = originalFetch; for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); } };
}
const request = (secret = 'synthetic-cron') => new Request('https://people.example.test/api/cron/onboarding-credentials', { headers: { authorization: `Bearer ${secret}` } });
test('onboarding delivery rejects unauthorised requests without claiming', async () => {
  const fixture = routeFixture();
  try { assert.equal((await fixture.route.GET(request('wrong'))).status, 401); assert.equal(fixture.calls.length, 0); } finally { fixture.cleanup(); }
});
test('delivery sends only distinct employee addresses and transient password, then acknowledges', async () => {
  const fixture = routeFixture();
  try {
    const result = await fixture.route.GET(request());
    assert.equal(result.status, 200, JSON.stringify({ calls: fixture.calls.map(({name,args}) => [name,args?.p_code]), response: await result.clone().json() }));
    assert.deepEqual(fixture.payload.recipients, ['work@example.test', 'home@example.test']);
    assert.equal(fixture.payload.login, 'work@example.test');
    assert.ok(typeof fixture.payload.temporaryPassword === "string" && fixture.payload.temporaryPassword.length >= 20);
    assert.equal(fixture.payload.deliveryId, deliveryId);
    assert.deepEqual(fixture.calls.map((call) => call.name), ['claim_due_onboarding_credentials', 'begin_onboarding_credential_delivery', 'complete_onboarding_credential_delivery']);
    assert.ok(!JSON.stringify(await result.json()).includes(fixture.payload.temporaryPassword));
    assert.ok(!JSON.stringify(fixture.calls).includes(fixture.payload.temporaryPassword));
  } finally { fixture.cleanup(); }
});
test('live destination must match verified MAM origin and exact webhook path', async () => {
  const fixture = routeFixture();
  try {
    for (const url of ['https://other.example.test/webhook/mam-people-hub-onboarding-credentials-v1',
      'https://n8n.example.test/webhook/other',
      'https://n8n.example.test/webhook/mam-people-hub-onboarding-credentials-v1?redirect=other',
      'http://n8n.example.test/webhook/mam-people-hub-onboarding-credentials-v1']) {
      process.env.ONBOARDING_CREDENTIAL_WEBHOOK_URL = url;
      assert.equal((await fixture.route.GET(request())).status, 503);
    }
    assert.equal(fixture.calls.length, 0);
  } finally { fixture.cleanup(); }
});
test('claimed contact snapshot is bound at begin before password rotation', async () => {
  const fixture = routeFixture({ stale: true });
  try {
    await fixture.route.GET(request());
    const begin = fixture.calls.find(call => call.name === 'begin_onboarding_credential_delivery');
    assert.deepEqual([begin.args.p_login, begin.args.p_work_email, begin.args.p_personal_email], ['work@example.test', 'work@example.test', 'home@example.test']);
    assert.equal(fixture.payload, undefined);
  } finally { fixture.cleanup(); }
});
test('password update failure records safe failure and never emails', async () => {
  const fixture = routeFixture({ updateFailed: true });
  try {
    assert.equal((await fixture.route.GET(request())).status, 503);
    assert.equal(fixture.payload, undefined);
    assert.equal(fixture.calls.at(-1).args.p_code, 'password_update_failed');
  } finally { fixture.cleanup(); }
});
test('webhook failure after password rotation holds for review without auto-retry or exposing password', async () => {
  const fixture = routeFixture({ throwOnFetch: true });
  try {
    const response = await fixture.route.GET(request());
    assert.equal(response.status, 503);
    assert.equal(fixture.calls.at(-1).args.p_code, 'delivery_uncertain');
    assert.ok(!JSON.stringify(await response.json()).includes(fixture.payload.temporaryPassword));
    assert.ok(!JSON.stringify(fixture.calls).includes(fixture.payload.temporaryPassword));
  } finally { fixture.cleanup(); }
});
test('rejected acknowledgement holds for review rather than marking delivery complete', async () => {
  const fixture = routeFixture({ badAcknowledgement: true });
  try {
    assert.equal((await fixture.route.GET(request())).status, 503);
    assert.equal(fixture.calls.at(-1).args.p_code, 'invalid_ack');
    assert.ok(!fixture.calls.some((call) => call.name === 'complete_onboarding_credential_delivery'));
  } finally { fixture.cleanup(); }
});
test('onboarding queue and archive release contain no plaintext credential storage', () => {
  const sql = readFileSync('supabase/migrations/20260930120100_onboarding_credentials.sql', 'utf8');
  assert.match(sql, /create table private\.employee_onboarding_credentials/i);
  assert.match(sql, /login_name\s*=\s*null/i);
  assert.doesNotMatch(sql, /(?:password|secret)\s+(?:text|varchar|bytea)/i);
  assert.match(sql, /for update skip locked/i);
});
