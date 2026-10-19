import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, loadMailHarness, request, ack } from './helpers/performance-review-mail-harness.mjs';

function queue(count, latencies = {}) {
  let now = 0;
  class Clock extends Date { static now() { return now; } }
  const uuid = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const rows = Array.from({ length: count }, (_, i) => {
    const row = fixture(); row.review_id = uuid(i + 1); row.delivery_id = uuid(i + 101); row.claim_token = uuid(i + 201);
    row.payload.reviewId = row.review_id; row.payload.reviewCode = `PR-2026-${i + 1}`; row.payload.document.code = row.payload.reviewCode;
    return row;
  });
  const state = new Map(rows.map(r => [r.delivery_id, { state: 'queued', sha: null, sending: false, outcome: null }]));
  const posts = [], caps = [];
  let release;
  const h = loadMailHarness({ clock: Clock, timers: { setTimeout(fn, duration) { caps.push(duration); return setTimeout(fn, latencies.lostClaim || latencies.late ? Math.min(duration, 25) : duration); } },
    rpc(name, args) {
      if (name === 'claim_performance_review_mail') {
        now += latencies.claim ?? 0;
        const result = rows.filter(r => state.get(r.delivery_id).state === 'queued' && (!args.p_review_id || r.review_id === args.p_review_id)).slice(0, args.p_limit);
        for (const r of result) state.get(r.delivery_id).state = 'claimed';
        if (result.length && latencies.lostClaim) return new Promise(() => {});
        return { data: structuredClone(result), error: null };
      }
      const row = rows.find(r => r.delivery_id === args.p_delivery_id && r.claim_token === args.p_claim_token);
      const s = row && state.get(row.delivery_id);
      if (!s) return { data: false, error: null };
      if (name === 'begin_performance_review_mail') {
        const allowed = s.state === 'claimed';
        if (allowed) { s.state = 'sending'; s.sending = true; s.sha = args.p_attachment_sha256; }
        return { data: allowed, error: null };
      }
      assert.equal(name, 'finish_performance_review_mail'); now += latencies.finish ?? 0;
      if (s.sha && s.sha !== args.p_attachment_sha256) return { data: false, error: null };
      if (s.state === 'provider_accepted') return { data: args.p_outcome === 'provider_accepted', error: null };
      if (args.p_outcome === 'provider_accepted' ? !s.sending : !['claimed', 'sending'].includes(s.state)) return { data: false, error: null };
      s.state = args.p_outcome === 'provider_accepted' ? 'provider_accepted' : 'needs_review';
      s.sha = args.p_attachment_sha256; s.outcome = args.p_outcome;
      return { data: true, error: null };
    },
    async fetch(_, init) {
      const wire = JSON.parse(init.body); posts.push(wire);
      const response = await h.route().POST(request('POST', { phase: 'begin', deliveryId: wire.deliveryId, claimToken: wire.claimToken, attachmentSha256: wire.attachment.sha256 }));
      assert.deepEqual(await response.json(), { ok: true, allowed: true });
      now += latencies.post ?? 0;
      if (latencies.unknown) throw Error('Synthetic acknowledgement lost after begin');
      if (latencies.late) return new Promise(resolve => { release = () => resolve(ack(wire)); });
      return ack(wire);
    },
  });
  return { h, rows, state, posts, caps, get release() { return release; }, get now() { return now; }, set now(value) { now = value; } };
}

test('AM-03 slow ordinary sends leave unattempted backlog queued for later scheduler runs', async () => {
  const q = queue(3, { claim: 4800, post: 14300, finish: 4700 });
  const first = await q.h.mail.dispatchPerformanceReviewMailOutbox();
  assert.deepEqual(first, { ok: true, code: 'processed', claimed: 1, providerAccepted: 1, held: 0 });
  assert.equal(q.now, 23800); assert.equal(q.posts.length, 1);
  assert.deepEqual([...q.state.values()].map(s => s.state), ['provider_accepted', 'queued', 'queued']);
  assert.deepEqual(await q.h.mail.dispatchPerformanceReviewMailOutbox(), first);
  assert.deepEqual([...q.state.values()].map(s => s.state), ['provider_accepted', 'provider_accepted', 'queued']);
  assert.deepEqual(await q.h.mail.dispatchPerformanceReviewMailOutbox(), first);
  assert.deepEqual([...q.state.values()].map(s => s.state), ['provider_accepted', 'provider_accepted', 'provider_accepted']);
  assert.equal(q.posts.length, 3);
  assert.ok(q.h.calls.filter(c => c.name === 'claim_performance_review_mail').every(c => c.args.p_limit === 1));
  assert.ok(q.caps.every(c => c > 0 && c <= 15000));
  assert.equal(q.h.logs.length, 0);
});

test('AM-03 insufficient full-attempt budget denies even the first durable claim', async () => {
  for (const available of [21999, 0, 1, 2000]) {
    const q = queue(2);
    const result = await q.h.mail.dispatchPerformanceReviewMailOutbox(null, q.now + available);
    assert.equal(q.h.calls.length, 0, 'insufficient budget must leave every durable claim untouched');
    assert.deepEqual(result, { ok: false, code: 'deadline', claimed: 0, providerAccepted: 0, held: 0 });
    assert.equal(q.h.clients, 0); assert.equal(q.h.calls.length, 0); assert.equal(q.posts.length, 0);
    assert.ok([...q.state.values()].every(s => s.state === 'queued'));
  }
  const q = queue(2);
  assert.equal((await q.h.mail.dispatchPerformanceReviewMailOutbox(null, q.now + 22000)).providerAccepted, 1);
  assert.deepEqual([...q.state.values()].map(s => s.state), ['provider_accepted', 'queued']);
});

test('AM-03 concurrent scheduler and per-review after retain one provider attempt per review', async () => {
  const q = queue(2);
  await Promise.all([q.h.mail.dispatchPerformanceReviewMailOutbox(), q.h.mail.dispatchPerformanceReviewMailForReview(q.rows[0].review_id)]);
  assert.equal(q.posts.length, 1);
  assert.deepEqual([...q.state.values()].map(s => s.state), ['provider_accepted', 'queued']);
  await Promise.all([q.h.mail.dispatchPerformanceReviewMailForReview(q.rows[1].review_id), q.h.mail.dispatchPerformanceReviewMailOutbox()]);
  assert.equal(q.posts.length, 2); assert.equal(new Set(q.posts.map(p => p.deliveryId)).size, 2);
  assert.ok([...q.state.values()].every(s => s.state === 'provider_accepted'));
  assert.ok(q.h.rpcRetries.every(value => value === false));
});

test('AM-03 lost claim acknowledgement never reclaims or attempts the occupied delivery', async () => {
  const q = queue(1, { lostClaim: true });
  const result = await q.h.mail.dispatchPerformanceReviewMailOutbox();
  assert.equal(result.code, 'claim_failed'); assert.equal(result.ok, false);
  assert.equal(q.state.get(q.rows[0].delivery_id).state, 'claimed');
  assert.equal((await q.h.mail.dispatchPerformanceReviewMailOutbox()).claimed, 0);
  assert.equal(q.posts.length, 0);
});

test('AM-03 unknown and late results stay held until a matching callback finish without another POST', async () => {
  for (const latencies of [{ unknown: true }, { late: true }]) {
    const q = queue(2, latencies);
    const result = await q.h.mail.dispatchPerformanceReviewMailOutbox();
    assert.equal(result.held, 1); assert.equal(q.posts.length, 1);
    assert.deepEqual([...q.state.values()].map(s => s.state), ['needs_review', 'queued']);
    if (q.release) { q.release(); await new Promise(setImmediate); }
    await q.h.mail.dispatchPerformanceReviewMailForReview(q.rows[0].review_id);
    assert.equal(q.posts.length, 1); assert.equal(q.state.get(q.rows[0].delivery_id).state, 'needs_review');
    const wire = q.posts[0];
    const body = { phase: 'finish', deliveryId: wire.deliveryId, claimToken: wire.claimToken, attachmentSha256: wire.attachment.sha256, outcome: 'provider_accepted' };
    assert.deepEqual(await (await q.h.route().POST(request('POST', { ...body, attachmentSha256: '0'.repeat(64) }))).json(), { ok: true, recorded: false });
    for (const outcome of ['provider_accepted', 'provider_accepted', 'unknown']) {
      const response = await q.h.route().POST(request('POST', { ...body, outcome }));
      assert.deepEqual(await response.json(), { ok: true, recorded: outcome === 'provider_accepted' });
    }
    assert.equal(q.state.get(q.rows[0].delivery_id).state, 'provider_accepted');
    assert.deepEqual(await (await q.h.route().POST(request('POST', { phase: 'begin', deliveryId: wire.deliveryId, claimToken: wire.claimToken, attachmentSha256: wire.attachment.sha256 }))).json(), { ok: true, allowed: false });
    assert.equal(q.posts.length, 1); assert.equal(q.state.get(q.rows[1].delivery_id).state, 'queued');
  }
});

test('AM-03 one-row claim envelope rejects two distinct rows before any provider dispatch', async () => {
  const q = queue(2);
  const h = loadMailHarness({ rpc: () => ({ data: q.rows, error: null }) });
  const result = await h.mail.dispatchPerformanceReviewMailOutbox();
  assert.equal(result.code, 'claim_failed'); assert.equal(h.requests.length, 0);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].args.p_limit, 1);
});
