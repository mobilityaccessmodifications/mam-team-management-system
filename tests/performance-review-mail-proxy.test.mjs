import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server.js';
import { loadMailProxyHarness } from './helpers/performance-review-mail-proxy-harness.mjs';
import { request, ids, app, readyHook, sharedSecret, cronSecret } from './helpers/performance-review-mail-harness.mjs';

const binding = { deliveryId: ids.delivery, claimToken: ids.claim, attachmentSha256: 'a'.repeat(64) };
test('AM-01 exact mail Proxy reaches real GET dispatcher readiness and POST callbacks before Supabase setup', async () => {
  for (const configured of [true, false]) {
    const p = loadMailProxyHarness({ configured, rpc: name => ({ data: name === 'claim_performance_review_mail' ? [] : true, error: null }), fetch: (url, init) => {
      assert.equal(String(url), readyHook); assert.equal(init.method, 'GET'); return Response.json({ ok: true, ready: true });
    } });
    const cases = [
      [request(), { ok: true, code: 'processed', claimed: 0, providerAccepted: 0, held: 0 }],
      [request('GET', undefined, { query: '?readiness=1' }), { ok: true, configured: true, ready: true }],
      [request('POST', { phase: 'readiness' }), { ok: true, ready: true }],
      [request('POST', { phase: 'begin', ...binding }), { ok: true, allowed: true }],
      [request('POST', { phase: 'finish', ...binding, outcome: 'provider_accepted' }), { ok: true, recorded: true }],
    ];
    for (const [req, expected] of cases) {
      const response = await p.handle(req);
      assert.equal(response.status, 200, req.method + ':' + req.url);
      assert.deepEqual(await response.json(), expected);
    }
    assert.deepEqual(p.counts, { configured: 0, config: 0, client: 0, claims: 0 });
    assert.equal(p.h.calls.filter(c => c.name === 'claim_performance_review_mail').length, 1);
    assert.equal(p.h.requests.length, 1);
  }
});

test('AM-01 exact endpoint still rejects missing wrong and swapped secrets before claims', async () => {
  const p = loadMailProxyHarness({ configured: false });
  for (const req of [request('GET', undefined, { bearer: '' }), request('GET', undefined, { bearer: 'wrong' }), request('GET', undefined, { bearer: sharedSecret }), request('POST', { phase: 'readiness' }, { secret: '' }), request('POST', { phase: 'readiness' }, { secret: cronSecret }), request('POST', { phase: 'begin', ...binding }, { secret: 'wrong' })]) {
    const response = await p.handle(req);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { ok: false, code: 'unauthorized' });
  }
  assert.deepEqual(p.counts, { configured: 0, config: 0, client: 0, claims: 0 });
  assert.equal(p.h.clients, 0); assert.equal(p.h.calls.length, 0); assert.equal(p.h.requests.length, 0);
});

test('AM-01 ordinary pages and non-exact mail siblings remain behind browser authentication', async () => {
  for (const configured of [true, false]) for (const pathname of ['/', '/performance-reviews', '/api/performance-reviews/mail/', '/api/performance-reviews/mail/extra', '/api/performance-reviews/mail-other', '/api/performance-reviews', '/api/performance-reviews/master-sync', '/api/performance-reviews/master-sync/extra']) {
    const p = loadMailProxyHarness({ configured });
    const response = await p.proxy(new NextRequest(app + pathname));
    assert.equal(response.status, 307);
    assert.match(new URL(response.headers.get('location')).pathname, /^\/login\/?$/);
    assert.equal(p.counts.claims, configured ? 1 : 0);
    assert.equal(p.h.clients, 0); assert.equal(p.h.calls.length, 0);
  }
});
