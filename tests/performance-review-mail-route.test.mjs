import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { fixture, loadMailHarness, environment, ids, request, ack, readyHook, app, sharedSecret } from './helpers/performance-review-mail-harness.mjs';

const beginBody = () => ({ phase: 'begin', deliveryId: ids.delivery, claimToken: ids.claim, attachmentSha256: 'a'.repeat(64) });

test('actual HTTP exports authenticate before any client, RPC or transport', async () => {
  const h = loadMailHarness(); const route = h.route();
  assert.equal(typeof route.GET, 'function'); assert.equal(typeof route.POST, 'function');
  const ast = ts.createSourceFile('route.ts', h.sources.get('src/app/api/performance-reviews/mail/route.ts'), ts.ScriptTarget.Latest, true);
  const exports = ast.statements.filter(s => ts.isFunctionDeclaration(s) && s.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)).map(s => s.name.text);
  assert.deepEqual(exports.sort(), ['GET','POST']);
  for (const req of [request('GET', undefined, { bearer: 'employee-session' }), request('GET', undefined, { bearer: '' }), request('POST', beginBody(), { secret: 'wrong-secret' }), request('POST', { phase: 'readiness' }, { secret: '' })]) {
    const response = await route[req.method](req); assert.equal(response.status, 401); assert.deepEqual(await response.json(), { ok: false, code: 'unauthorized' });
  }
  assert.equal(h.clients, 0); assert.equal(h.calls.length, 0); assert.equal(h.requests.length, 0); assert.equal(h.logs.length, 0);
});

test('POST readiness exact acknowledgement needs neither a service client nor any RPC callback', async () => {
  const h = loadMailHarness();
  const response = await h.route().POST(request('POST', { phase: 'readiness' }));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, ready: true });
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(h.clients, 0); assert.equal(h.requests.length, 0);
});

test('GET exact readiness probes only the dedicated native Header Auth ready trigger', async () => {
  const h = loadMailHarness({ fetch: (url, init) => {
    assert.equal(String(url), readyHook); assert.equal(init.method, 'GET'); assert.equal(init.headers['X-MAM-Performance-Secret'], sharedSecret);
    assert.equal(init.redirect, 'error'); assert.equal(init.body, undefined); return Response.json({ ok: true, ready: true });
  } });
  const response = await h.route().GET(request('GET', undefined, { query: '?readiness=1' }));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, configured: true, ready: true });
  assert.equal(h.clients, 0); assert.equal(h.calls.length, 0); assert.equal(h.requests.length, 1);
});

test('authenticated GET without params drains only the native new outbox with safe aggregate output', async () => {
  const h = loadMailHarness({ rpc: (name, args) => {
    if (name === 'claim_performance_review_mail') { assert.deepEqual(args, { p_review_id: null, p_limit: 10 }); return { data: [fixture()], error: null }; }
    assert.equal(name, 'finish_performance_review_mail'); return { data: true, error: null };
  }, fetch: (_, init) => ack(JSON.parse(init.body)) });
  const response = await h.route().GET(request());
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, code: 'processed', claimed: 1, providerAccepted: 1, held: 0 });
  assert.equal(h.requests.length, 1); assert.equal(h.logs.length, 0);
});

test('begin and finish map only actual scalar Boolean RPC results to exact HTTP shapes', async () => {
  for (const phase of ['begin','finish']) for (const value of [true, false, null, 'true', 'false', [], [true], {}, { allowed: true }, undefined]) {
    const h = loadMailHarness({ rpc: (name, args) => {
      assert.equal(name, phase === 'begin' ? 'begin_performance_review_mail' : 'finish_performance_review_mail');
      assert.deepEqual(args, { p_delivery_id: ids.delivery, p_claim_token: ids.claim, p_attachment_sha256: 'a'.repeat(64), ...(phase === 'finish' ? { p_outcome: 'provider_accepted' } : {}) });
      return { data: value, error: null };
    } });
    const body = { ...beginBody(), phase, ...(phase === 'finish' ? { outcome: 'provider_accepted' } : {}) };
    const response = await h.route().POST(request('POST', body));
    assert.equal(response.status, typeof value === 'boolean' ? 200 : 503, phase + ':' + JSON.stringify(value));
    assert.deepEqual(await response.json(), typeof value === 'boolean' ? { ok: true, [phase === 'begin' ? 'allowed' : 'recorded']: value } : { ok: false, code: 'unavailable' });
    assert.equal(h.calls.length, 1); assert.equal(h.requests.length, 0); assert.equal(h.logs.length, 0);
  }
});

test('finish accepts only the three contracted outcomes and never converts a rejected RPC into success', async () => {
  for (const outcome of ['provider_accepted','unknown','rejected']) {
    const h = loadMailHarness({ rpc: (name, args) => { assert.equal(name, 'finish_performance_review_mail'); assert.equal(args.p_outcome, outcome); return { data: false, error: null }; } });
    const response = await h.route().POST(request('POST', { ...beginBody(), phase: 'finish', outcome }));
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, recorded: false });
  }
  for (const failing of ['throw','error']) {
    const h = loadMailHarness({ rpc: () => { if (failing === 'throw') throw Error('synthetic-note-claim-secret-fragment'); return { data: true, error: { message: 'synthetic-note-claim-secret-fragment' } }; } });
    const response = await h.route().POST(request('POST', beginBody()));
    assert.equal(response.status, 503); assert.equal(await response.text(), '{"ok":false,"code":"unavailable"}'); assert.equal(h.logs.length, 0);
  }
});

test('route rejects injected fields, unsafe identifiers, bodies, origins and all non-exact queries before client construction', async () => {
  const h = loadMailHarness({ rpc: () => ({ data: true, error: null }) }); const route = h.route();
  const bodies = [
    { phase: 'readiness', url: 'https://foreign.example.test' }, { ...beginBody(), recipient: 'foreign@example.test' },
    { ...beginBody(), actor: 'employee' }, { ...beginBody(), document: {} }, { ...beginBody(), url: app },
    { ...beginBody(), deliveryId: 'forged' }, { ...beginBody(), claimToken: {} }, { ...beginBody(), attachmentSha256: 'A'.repeat(64) },
    { ...beginBody(), phase: 'finish', outcome: 'delivered' }, { ...beginBody(), phase: 'finish', outcome: true },
    { ...beginBody(), outcome: 'provider_accepted' }, { phase: 'begin' }, [], null, '{not JSON', 'x'.repeat(1025),
    JSON.stringify({ ...beginBody(), secret: 'synthetic-private-body-marker' }),
  ];
  for (const body of bodies) {
    const response = await route.POST(request('POST', body)); assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(await response.json(), { ok: false, code: 'invalid_request' });
  }
  for (const query of ['?readiness=0','?readiness=true','?readiness=1&readiness=1','?readiness=%31','?readiness=1&reviewId=' + ids.review,'?reviewId=' + ids.review]) assert.equal((await route.GET(request('GET', undefined, { query }))).status, 400);
  for (const req of [
    request('POST', beginBody(), { query: '?readiness=1' }),
    request('POST', beginBody(), { headers: { origin: 'https://foreign.example.test' } }),
    request('GET', undefined, { headers: { origin: 'https://foreign.example.test' } }),
    new Request('https://foreign.example.test/api/performance-reviews/mail', { method: 'POST', headers: { 'X-MAM-Performance-Secret': sharedSecret, 'content-type': 'application/json' }, body: JSON.stringify(beginBody()) }),
    request('POST', beginBody(), { headers: { 'content-type': 'text/plain' } }),
    request('POST', beginBody(), { headers: { 'content-length': '999999999' } }),
  ]) assert.equal((await route[req.method](req)).status, 400);
  assert.equal(h.clients, 0); assert.equal(h.requests.length, 0); assert.equal(h.logs.length, 0);
});

test('disabled and sandbox real HTTP routes cannot claim, call a service client or send', async () => {
  for (const patch of [{ PERFORMANCE_REVIEW_EMAIL_MODE: undefined }, { PERFORMANCE_REVIEW_EMAIL_MODE: 'disabled' }, { MAM_SANDBOX_E2E: 'true' }]) {
    const h = loadMailHarness({ env: environment(patch) });
    const response = await h.route().GET(request()); assert.equal(response.status, 200); assert.equal((await response.json()).claimed, 0);
    assert.equal((await h.route().GET(request('GET', undefined, { query: '?readiness=1' }))).status, 503);
    for (const body of [{ phase: 'readiness' }, beginBody(), { ...beginBody(), phase: 'finish', outcome: 'unknown' }]) assert.equal((await h.route().POST(request('POST', body))).status, 503);
    assert.equal(h.clients, 0); assert.equal(h.calls.length, 0); assert.equal(h.requests.length, 0); assert.equal(h.logs.length, 0);
  }
});

test('readiness fails closed on non-exact response, every redirect and hanging body, with zero service RPC', async () => {
  const cases = [() => Response.json({ ok: true }), () => Response.json({ ok: true, ready: true, sent: false }), () => Response.json({ ok: true, ready: 'true' }),
    ...[301,302,303,307,308].flatMap(status => [readyHook, 'https://foreign.example.test'].map(location => () => new Response(null, { status, headers: { location } }))),
    () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), { headers: { 'content-type': 'application/json' } }),
  ];
  for (const response of cases) {
    const h = loadMailHarness({ timers: { setTimeout: (fn, delay) => setTimeout(fn, Math.min(25, delay)) }, fetch: response });
    const result = await h.route().GET(request('GET', undefined, { query: '?readiness=1' }));
    assert.equal(result.status, 503); assert.deepEqual(await result.json(), { ok: false, configured: true, ready: false });
    assert.equal(h.clients, 0); assert.equal(h.calls.length, 0); assert.equal(h.requests.length, 1); assert.equal(h.logs.length, 0);
  }
});

test('POST request-body and RPC deadlines serialize safe failures and never leak HR or secrets', async () => {
  for (const boundary of ['body','rpc']) {
    const h = loadMailHarness({ timers: { setTimeout: (fn, delay) => setTimeout(fn, Math.min(25, delay)) }, rpc: () => new Promise(() => {}) });
    const req = boundary === 'body' ? new Request(app + '/api/performance-reviews/mail', { method: 'POST', headers: { 'X-MAM-Performance-Secret': sharedSecret, 'content-type': 'application/json' }, body: new ReadableStream({ pull() { return new Promise(() => {}); } }), duplex: 'half' }) : request('POST', beginBody());
    const response = await h.route().POST(req); assert.equal(response.status, boundary === 'body' ? 400 : 503);
    assert.doesNotMatch(await response.text(), /Synthetic|synthetic-|claimToken|managerNote|contentBase64|stack/); assert.equal(h.logs.length, 0);
    if (boundary === 'body') assert.equal(h.clients, 0);
  }
});

test('callback rejects contradictory native RPC status and missing error metadata without provider effects', async () => {
  for (const bad of [{ error: undefined }, { error: null, status: 503 }, { error: null, status: '200' }]) {
    const h = loadMailHarness({ rpc: () => ({ data: true, ...bad }) });
    const response = await h.route().POST(request('POST', beginBody())); assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, code: 'unavailable' }); assert.equal(h.requests.length, 0);
  }
  const h = loadMailHarness({ rpc: () => ({ data: true, error: null, status: 200 }) });
  assert.equal((await h.route().POST(request('POST', beginBody()))).status, 200); assert.deepEqual(h.rpcRetries, [false]);
});

test('readiness rechecks live mode after an awaited request body before acknowledging', async () => {
  let controller;
  const h = loadMailHarness();
  const req = new Request(app + '/api/performance-reviews/mail', { method: 'POST', headers: { 'X-MAM-Performance-Secret': sharedSecret, 'content-type': 'application/json' }, body: new ReadableStream({ start(c) { controller = c; } }), duplex: 'half' });
  const responsePromise = h.route().POST(req);
  await new Promise(setImmediate);
  h.env.PERFORMANCE_REVIEW_EMAIL_MODE = 'disabled';
  controller.enqueue(new TextEncoder().encode('{"phase":"readiness"}')); controller.close();
  const response = await responsePromise;
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { ok: false, code: 'unavailable' });
  assert.equal(h.clients, 0); assert.equal(h.requests.length, 0);
});
