import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { fixture, loadMailHarness, environment, hook, ids, ack } from './helpers/performance-review-mail-harness.mjs';

test('default-disabled known-review and worker paths have zero side effects', async () => {
  const h = loadMailHarness({ env: environment({ PERFORMANCE_REVIEW_EMAIL_MODE: undefined }) });
  assert.equal(typeof h.mail.dispatchPerformanceReviewMailForReview, 'function');
  assert.equal(typeof h.mail.dispatchPerformanceReviewMailOutbox, 'function');
  assert.equal(await h.mail.dispatchPerformanceReviewMailForReview(ids.review), undefined);
  assert.deepEqual(await h.mail.dispatchPerformanceReviewMailOutbox(), { ok: true, code: 'disabled', claimed: 0, providerAccepted: 0, held: 0 });
  assert.equal(h.clients, 0); assert.equal(h.calls.length, 0); assert.equal(h.requests.length, 0);
});

test('live worker sends canonical closed Careers payload and native Word bytes with note separate', async () => {
  const row = fixture(); let wire;
  const h = loadMailHarness({
    rpc: (name, args) => {
      if (name === 'claim_performance_review_mail') { assert.deepEqual(args, { p_review_id: null, p_limit: 1 }); return { data: [row], error: null }; }
      assert.equal(name, 'finish_performance_review_mail');
      assert.deepEqual(args, { p_delivery_id: ids.delivery, p_claim_token: ids.claim, p_outcome: 'provider_accepted', p_attachment_sha256: wire.attachment.sha256 });
      return { data: true, error: null };
    },
    fetch: (url, init) => {
      assert.equal(String(url), hook); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
      assert.equal(init.headers['X-MAM-Performance-Secret'], h.env.MAM_N8N_PERFORMANCE_WEBHOOK_SECRET);
      wire = JSON.parse(init.body); return ack(wire);
    },
  });
  assert.deepEqual(await h.mail.dispatchPerformanceReviewMailOutbox(), { ok: true, code: 'processed', claimed: 1, providerAccepted: 1, held: 0 });
  assert.deepEqual(Object.keys(wire).sort(), ['version','event','eventKey','deliveryId','reviewId','reviewCode','claimToken','employeeName','managerName','finalisedAt','recipient','ccRecipients','managerNote','attachment'].sort());
  assert.equal(wire.version, 1); assert.equal(wire.event, 'performance-review-finalised');
  assert.equal(wire.eventKey, `performance-review:${ids.review}:finalised`); assert.equal(wire.recipient, 'manager@mobilityaccess.com.au');
  assert.deepEqual(wire.ccRecipients, row.payload.ccRecipients);
  assert.equal(wire.managerNote, row.payload.managerNote);
  assert.deepEqual(Object.keys(wire.attachment).sort(), ['fileName','mimeType','contentBase64','sha256'].sort());
  assert.equal(wire.attachment.fileName, 'PR-2026-1-manager.docx');
  assert.equal(wire.attachment.mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const bytes = Buffer.from(wire.attachment.contentBase64, 'base64');
  const download = h.load('src/lib/performance-review-document.ts').buildPerformanceReviewDownload(row.payload.document);
  assert.deepEqual(bytes, Buffer.from(download.bytes)); assert.equal(bytes.toString('base64'), wire.attachment.contentBase64);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), wire.attachment.sha256);
  const parts = unzipSync(bytes), xml = strFromU8(parts['word/document.xml']);
  assert.match(xml, /MAM Performance review/); assert.match(xml, /Synthetic self answer/); assert.match(xml, /Synthetic manager answer/);
  assert.match(xml, /2 Meets expectations/); assert.match(xml, /landscape/); assert.doesNotMatch(xml, /unique-not-in-word|Synthetic private note/);
  assert.ok(Object.hasOwn(parts, '[Content_Types].xml')); assert.equal(h.logs.length, 0);
});

test('sandbox, disabled, invalid mode and untrusted configuration deny worker and known-review before any client', async () => {
  for (const patch of [
    { MAM_SANDBOX_E2E: 'true' }, { MAM_SANDBOX_E2E: ' TRUE ' },
    { PERFORMANCE_REVIEW_EMAIL_MODE: 'disabled' }, { PERFORMANCE_REVIEW_EMAIL_MODE: 'LIVE' },
    { MAM_N8N_PERFORMANCE_WEBHOOK_SECRET: undefined }, { MAM_N8N_PERFORMANCE_WEBHOOK_SECRET: 'weak' },
    { MAM_N8N_PERFORMANCE_WEBHOOK_ORIGIN: 'https://foreign.example.test', MAM_N8N_PERFORMANCE_WEBHOOK_URL: 'https://foreign.example.test/webhook/mam-people-hub-performance-review-mail-v1' },
    ...['http://n8n.srv1866578.hstgr.cloud', 'https://n8n.srv1866578.hstgr.cloud:444', 'https://user@n8n.srv1866578.hstgr.cloud', hook + '?x=1', hook + '#fragment', hook + '/', hook.replace('/webhook/', '/webhook-test/'), hook.replace('/webhook/', '/x/../webhook/')].map(url => ({ MAM_N8N_PERFORMANCE_WEBHOOK_URL: url })),
  ]) {
    const h = loadMailHarness({ env: environment(patch), rpc: () => ({ data: [], error: null }) });
    const result = await h.mail.dispatchPerformanceReviewMailOutbox();
    assert.equal(result.claimed, 0); assert.equal(result.providerAccepted, 0);
    await h.mail.dispatchPerformanceReviewMailForReview(ids.review);
    assert.equal(h.clients, 0, JSON.stringify(patch)); assert.equal(h.requests.length, 0); assert.equal(h.calls.length, 0);
  }
});

test('sandbox startup rejects new outbound settings and live mode while blank or disabled stays inert', () => {
  const h = loadMailHarness();
  const { assertSandboxEnvironment } = h.load('src/lib/sandbox-safety.ts');
  const env = { MAM_SANDBOX_E2E: 'true', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', NEXT_PUBLIC_APP_URL: 'http://localhost:3000', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'synthetic', SUPABASE_SECRET_KEY: 'synthetic' };
  assert.doesNotThrow(() => assertSandboxEnvironment(env));
  assert.doesNotThrow(() => assertSandboxEnvironment({ ...env, PERFORMANCE_REVIEW_EMAIL_MODE: 'disabled' }));
  for (const key of ['MAM_N8N_PERFORMANCE_WEBHOOK_ORIGIN','MAM_N8N_PERFORMANCE_WEBHOOK_URL','MAM_N8N_PERFORMANCE_WEBHOOK_SECRET']) assert.throws(() => assertSandboxEnvironment({ ...env, [key]: 'synthetic' }), /forbids/);
  assert.throws(() => assertSandboxEnvironment({ ...env, PERFORMANCE_REVIEW_EMAIL_MODE: 'live' }), /forbids/);
});

test('known-review positive is scoped to the committed review and errors never escape the after hook', async () => {
  let wire;
  const h = loadMailHarness({ rpc: (name, args) => {
    if (name === 'claim_performance_review_mail') { assert.deepEqual(args, { p_review_id: ids.review, p_limit: 1 }); return { data: [fixture()], error: null }; }
    assert.equal(args.p_attachment_sha256, wire.attachment.sha256); return { data: true, error: null };
  }, fetch: (_, init) => { wire = JSON.parse(init.body); return ack(wire); } });
  assert.equal(await h.mail.dispatchPerformanceReviewMailForReview(ids.review), undefined);
  assert.equal(h.requests.length, 1); assert.equal(h.calls.length, 2);
  for (const id of ['forged-review', ids.review.toUpperCase().replace('10000000', 'ABCDEFAB'), null, {}, ids.review + ' ']) {
    const denied = loadMailHarness({ rpc: () => ({ data: [], error: null }) });
    await denied.mail.dispatchPerformanceReviewMailForReview(id);
    assert.equal(denied.clients, 0, String(id));
  }
  const failed = loadMailHarness({ rpc: () => { throw Error('synthetic-credential-fragment'); } });
  assert.equal(await failed.mail.dispatchPerformanceReviewMailForReview(ids.review), undefined); assert.equal(failed.logs.length, 0);
});

test('malformed claims and non-final manager snapshots remain sticky with zero webhook dispatch', async () => {
  const changes = [
    r => { r.actor = 'employee'; }, r => { r.payload.recipient = 'foreign@example.test'; },
    r => { r.review_id = 'not-uuid'; }, r => { r.claim_token = ids.claim.toUpperCase().replace('30000000', 'ABCDEFAB'); },
    r => { r.payload.reviewId = '10000000-0000-4000-8000-000000000099'; },
    r => { r.payload.reviewCode = 'PR-2026-2'; }, r => { r.payload.finalisedAt = null; },
    r => { r.payload.finalisedAt = '2026-02-30T05:00:00Z'; }, r => { r.payload.finalisedAt = '2026-10-14T05:00:00Z'; },
    r => { r.payload.document.audience = 'admin'; },
    r => { for (const k of ['managerAnswers','ratings','summary','overallRating','meeting']) delete r.payload.document[k]; r.payload.document.audience = 'employee'; },
    r => { r.payload.document.meeting = null; }, r => { r.payload.document.managerNote = 'must-not-be-in-word'; },
    r => { r.payload.document.selfAnswers[0] = ''; }, r => { r.payload.document.managerAnswers[0] = ''; },
    r => { r.payload.document.ratings[0] = ''; }, r => { r.payload.document.summary = ''; },
    r => { r.payload.managerNote = ''; }, r => { r.payload.managerNote = '\u0000'; }, r => { r.payload.document.employee.company = 'Other'; },
    r => { Object.defineProperty(r.payload, 'managerNote', { get() { throw Error('must not invoke'); } }); },
    r => { r.payload[Symbol('extra')] = true; },
  ];
  for (const change of changes) {
    const row = fixture(); change(row);
    const h = loadMailHarness({ rpc: name => ({ data: name === 'claim_performance_review_mail' ? [row] : true, error: null }), fetch: (_, init) => ack(JSON.parse(init.body)) });
    const result = await h.mail.dispatchPerformanceReviewMailOutbox();
    assert.equal(result.ok, false, String(change)); assert.equal(result.held, 1); assert.equal(h.requests.length, 0, String(change));
    assert.equal(h.calls.filter(c => c.name.includes('begin')).length, 0); assert.equal(h.logs.length, 0);
  }
});

test('actual canonical Word overflow is held before network without replacing the Word builder', async () => {
  const row = fixture(), text = 'x\t'.repeat(4000);
  row.payload.document.selfAnswers.fill(text); row.payload.document.managerAnswers.fill(text);
  const h = loadMailHarness({ rpc: name => ({ data: name === 'claim_performance_review_mail' ? [row] : true, error: null }), fetch: (_, init) => ack(JSON.parse(init.body)) });
  assert.ok(h.load('src/lib/performance-review-document.ts').buildPerformanceReviewDownload(row.payload.document).bytes.length > 2 * 1024 * 1024);
  const result = await h.mail.dispatchPerformanceReviewMailOutbox();
  assert.equal(result.providerAccepted, 0); assert.equal(result.held, 1); assert.equal(h.requests.length, 0);
});

test('exact response identity is required and every ambiguous acknowledgement is a sticky unknown', async () => {
  const variants = [
    w => ack(w, { deliveryId: ids.claim }), w => ack(w, { eventKey: 'performance-review:forged:finalised' }),
    w => ack(w, { actualRecipients: [w.recipient] }), w => ack(w, { actualRecipients: [w.recipient, ...w.ccRecipients].reverse() }),
    w => ack(w, { actualRecipients: [w.recipient, ...w.ccRecipients, 'foreign@mobilityaccess.com.au'] }),
    w => ack(w, { actualRecipients: [w.recipient, w.ccRecipients[1], w.ccRecipients[0]] }),
    w => ack(w, { actualRecipients: [w.recipient, w.ccRecipients[0], w.ccRecipients[0]] }),
    w => ack(w, { actualRecipients: ['foreign@example.test'] }), w => ack(w, { actualRecipients: 'careers@mobilityaccess.com.au' }),
    w => ack(w, { actualRecipients: ['careers@mobilityaccess.com.au', 'foreign@example.test'] }),
    w => ack(w, { attachmentSha256: 'a'.repeat(64) }), w => ack(w, { status: 'held' }), w => ack(w, { ok: false }),
    w => ack(w, { extra: 'must-reject' }), () => Response.json({ ok: true }), () => new Response('not-json'),
    () => new Response('x'.repeat(17000)), () => Response.json({ ok: true }, { status: 500 }),
    () => { throw Error('synthetic-secret-response-error'); },
    ...[301, 302, 303, 307, 308].flatMap(status => [hook, 'https://foreign.example.test'].map(location => () => new Response(null, { status, headers: { location } }))),
    w => ({ ...ack(w), status: 200, ok: true, redirected: true, body: ack(w).body }),
  ];
  for (const variant of variants) {
    const h = loadMailHarness({ rpc: name => ({ data: name === 'claim_performance_review_mail' ? [fixture()] : true, error: null }), fetch: (_, init) => variant(JSON.parse(init.body)) });
    const result = await h.mail.dispatchPerformanceReviewMailOutbox();
    assert.equal(result.ok, false, String(variant)); assert.equal(result.providerAccepted, 0); assert.equal(result.held, 1);
    assert.equal(h.requests.length, 1); assert.equal(h.requests[0].init.redirect, 'error');
    assert.equal(h.calls.at(-1).name, 'finish_performance_review_mail'); assert.equal(h.calls.at(-1).args.p_outcome, 'unknown');
    assert.equal(h.logs.length, 0);
  }
});

test('claim errors, malformed envelopes and excess or duplicate rows fail closed without sending', async () => {
  for (const response of [{ data: [fixture()], error: { message: 'synthetic-private-db-error' } }, { data: null, error: null }, { data: true, error: null }, { data: {}, error: null }, { data: [fixture(), fixture()], error: null }, { data: Array.from({ length: 11 }, fixture), error: null }]) {
    const h = loadMailHarness({ rpc: () => response, fetch: (_, init) => ack(JSON.parse(init.body)) });
    const result = await h.mail.dispatchPerformanceReviewMailOutbox();
    assert.equal(result.ok, false); assert.equal(h.requests.length, 0); assert.equal(h.logs.length, 0);
  }
});

test('provider acceptance followed by failed finish is held without downgrade or an automatic second send', async () => {
  for (const value of [false, null, 'true', [true], { ok: true }, undefined, 'throw']) {
    let claimed = false;
    const h = loadMailHarness({ rpc: name => {
      if (name === 'claim_performance_review_mail') { const rows = claimed ? [] : [fixture()]; claimed = true; return { data: rows, error: null }; }
      if (value === 'throw') throw Error('synthetic-private-finish-error');
      return { data: value, error: null };
    }, fetch: (_, init) => ack(JSON.parse(init.body)) });
    const result = await h.mail.dispatchPerformanceReviewMailOutbox();
    assert.equal(result.ok, false); assert.equal(result.providerAccepted, 0); assert.equal(result.held, 1);
    await h.mail.dispatchPerformanceReviewMailOutbox();
    assert.equal(h.requests.length, 1); assert.equal(h.calls.filter(c => c.name === 'finish_performance_review_mail').length, 1);
    assert.equal(h.calls.find(c => c.name === 'finish_performance_review_mail').args.p_outcome, 'provider_accepted'); assert.equal(h.logs.length, 0);
  }
});

test('one deadline bounds claim, response headers and a body that ignores abort forever', async () => {
  for (const boundary of ['claim','headers','body','finish']) {
    let cancelled = false;
    const h = loadMailHarness({ timers: { setTimeout: (fn, delay) => setTimeout(fn, Math.min(delay, 25)) },
      rpc: name => {
        if ((boundary === 'claim' && name === 'claim_performance_review_mail') || (boundary === 'finish' && name === 'finish_performance_review_mail')) return new Promise(() => {});
        return { data: name === 'claim_performance_review_mail' ? [fixture()] : true, error: null };
      }, fetch: (_, init) => {
        if (boundary === 'headers') return new Promise(() => {});
        if (boundary === 'body') return new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } });
        return ack(JSON.parse(init.body));
      } });
    let guard;
    let result;
    try { result = await Promise.race([h.mail.dispatchPerformanceReviewMailOutbox(), new Promise((_, reject) => { guard = setTimeout(() => reject(Error('deadline did not bound ' + boundary)), 1500); })]); }
    finally { clearTimeout(guard); }
    assert.equal(result.ok, false, boundary); assert.ok(h.requests.length <= 1);
    if (boundary === 'body') { assert.equal(cancelled, true); assert.equal(h.calls.at(-1).args.p_outcome, 'unknown'); }
    assert.equal(h.logs.length, 0);
  }
});

test('producer validates the closed canonical wire before serialization including raw accessors and symbols', async () => {
  let wire;
  const h = loadMailHarness({ rpc: name => ({ data: name === 'claim_performance_review_mail' ? [fixture()] : true, error: null }), fetch: (_, init) => { wire = JSON.parse(init.body); return ack(wire); } });
  await h.mail.dispatchPerformanceReviewMailOutbox();
  assert.equal(typeof h.mail.validatePerformanceReviewMailPayload, 'function');
  assert.doesNotThrow(() => h.mail.validatePerformanceReviewMailPayload(wire));
  const changes = [
    w => { w.actor = 'employee'; }, w => { w.recipient = 'foreign@example.test'; }, w => { w.recipient = ['careers@mobilityaccess.com.au']; },
    w => { w.reviewId = 'forged'; }, w => { w.reviewId = ids.claim; }, w => { w.claimToken = ids.claim.toUpperCase().replace('30000000','ABCDEFAB'); },
    w => { w.event = 'performance-review-started'; }, w => { w.version = '1'; }, w => { w.eventKey += ' '; },
    w => { w.attachment.contentBase64 += '\n'; }, w => { w.attachment.contentBase64 = 'eA'; }, w => { w.attachment.contentBase64 = 'eB=='; },
    w => { w.attachment.contentBase64 = Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64'); },
    w => { w.attachment.sha256 = 'b'.repeat(64); }, w => { w.attachment.mimeType = 'text/html'; }, w => { w.attachment.fileName = 'PR-2026-1-manager.doc'; },
    w => { w.attachment.bytes = []; }, w => { w.managerNote = {}; }, w => { w.employeeName = ''; },
    w => { w[Symbol('extra')] = true; }, w => { Object.defineProperty(w, 'recipient', { get() { throw Error('accessor must not run'); } }); },
  ];
  for (const change of changes) { const altered = structuredClone(wire); change(altered); assert.throws(() => h.mail.validatePerformanceReviewMailPayload(altered), /Invalid performance review data\.|invalid_payload/); }
});

test('native service RPCs explicitly disable retries and reject contradictory transport status', async () => {
  const h = loadMailHarness({ rpc: name => ({ data: name === 'claim_performance_review_mail' ? [fixture()] : true, error: null, status: 200 }), fetch: (_, init) => ack(JSON.parse(init.body)) });
  assert.equal((await h.mail.dispatchPerformanceReviewMailOutbox()).providerAccepted, 1);
  assert.deepEqual(h.rpcRetries, [false, false]);
  for (const phase of ['claim','finish']) for (const bad of [{ error: undefined }, { error: null, status: 503 }, { error: null, status: '200' }, { error: null, status: 0 }]) {
    const fail = loadMailHarness({ rpc: name => ({ data: name === 'claim_performance_review_mail' ? [fixture()] : true, error: null,
      ...((phase === 'claim') === (name === 'claim_performance_review_mail') ? bad : {}) }), fetch: (_, init) => ack(JSON.parse(init.body)) });
    const result = await fail.mail.dispatchPerformanceReviewMailOutbox();
    assert.equal(result.ok, false, phase + JSON.stringify(bad)); assert.equal(result.providerAccepted, 0);
    assert.equal(fail.requests.length, phase === 'claim' ? 0 : 1);
  }
});
