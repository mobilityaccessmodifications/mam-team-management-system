import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, loadMailHarness, ids, request, ack } from './helpers/performance-review-mail-harness.mjs';

function serviceBoundary({ unknownProvider = false, replayClaims = false } = {}) {
  let state = 'queued', sha = null, providers = 0, wire;
  const row = fixture();
  const h = loadMailHarness({
    rpc(name, args) {
      if (name === 'claim_performance_review_mail') {
        const claim = state === 'queued' || replayClaims;
        if (state === 'queued') state = 'claimed';
        return { data: claim ? [structuredClone(row)] : [], error: null };
      }
      const same = args.p_delivery_id === ids.delivery && args.p_claim_token === ids.claim;
      if (name === 'begin_performance_review_manager_mail') {
        const permit = same && state === 'claimed';
        if (permit) { state = 'sending'; sha = args.p_attachment_sha256; }
        return { data: permit, error: null };
      }
      assert.equal(name, 'finish_performance_review_mail');
      if (!same || sha !== args.p_attachment_sha256 || !['sending','provider_accepted','needs_review'].includes(state)) return { data: false, error: null };
      if (state === 'provider_accepted') return { data: args.p_outcome === 'provider_accepted', error: null };
      if (state === 'needs_review') return { data: args.p_outcome !== 'provider_accepted', error: null };
      state = args.p_outcome === 'provider_accepted' ? 'provider_accepted' : 'needs_review';
      return { data: true, error: null };
    },
    async fetch(_, init) {
      wire = JSON.parse(init.body);
      const permit = await h.route().POST(request('POST', { phase: 'begin', recipient: 'manager@mobilityaccess.com.au', deliveryId: wire.deliveryId, claimToken: wire.claimToken, attachmentSha256: wire.attachment.sha256 }));
      const decision = await permit.json();
      assert.equal(typeof decision.allowed, 'boolean');
      if (!decision.allowed) return ack(wire, { ok: false, status: 'held' });
      providers++;
      if (unknownProvider) throw Error('Synthetic provider accepted but acknowledgement unknown');
      const finished = await h.route().POST(request('POST', { phase: 'finish', deliveryId: wire.deliveryId, claimToken: wire.claimToken, attachmentSha256: wire.attachment.sha256, outcome: 'provider_accepted' }));
      assert.deepEqual(await finished.json(), { ok: true, recorded: true });
      return ack(wire);
    },
  });
  return { h, get state() { return state; }, get providers() { return providers; }, get wire() { return wire; } };
}

test('real worker, real callback routes and inert native service CAS allow one provider operation under concurrency', async () => {
  const boundary = serviceBoundary(); const { h } = boundary;
  const results = await Promise.all([h.mail.dispatchPerformanceReviewMailOutbox(), h.mail.dispatchPerformanceReviewMailForReview(ids.review)]);
  assert.equal(results[1], undefined); assert.equal(boundary.providers, 1); assert.equal(boundary.state, 'provider_accepted');
  const wire = boundary.wire;
  const payload = { phase: 'begin', recipient: 'manager@mobilityaccess.com.au', deliveryId: ids.delivery, claimToken: ids.claim, attachmentSha256: wire.attachment.sha256 };
  for (const body of [payload, { ...payload, claimToken: '30000000-0000-4000-8000-000000000099' }]) {
    const response = await h.route().POST(request('POST', body)); assert.deepEqual(await response.json(), { ok: true, allowed: false });
  }
  for (const [patch, recorded] of [[{ outcome: 'unknown' }, false], [{ outcome: 'rejected' }, false], [{ outcome: 'provider_accepted' }, true], [{ outcome: 'provider_accepted', attachmentSha256: 'a'.repeat(64) }, false]]) {
    const response = await h.route().POST(request('POST', { phase: 'finish', deliveryId: payload.deliveryId, claimToken: payload.claimToken, attachmentSha256: payload.attachmentSha256, ...patch })); assert.deepEqual(await response.json(), { ok: true, recorded });
  }
  assert.equal(boundary.providers, 1); assert.equal(boundary.state, 'provider_accepted'); assert.equal(h.logs.length, 0);
});

test('a repeated stale claim cannot repeat the provider operation or downgrade an accepted receipt', async () => {
  const boundary = serviceBoundary({ replayClaims: true });
  assert.equal((await boundary.h.mail.dispatchPerformanceReviewMailOutbox()).providerAccepted, 1);
  const duplicate = await boundary.h.mail.dispatchPerformanceReviewMailOutbox();
  assert.equal(duplicate.providerAccepted, 0); assert.equal(duplicate.held, 1);
  assert.equal(boundary.providers, 1); assert.equal(boundary.state, 'provider_accepted');
});

test('uncertain post-begin provider boundary becomes sticky needs-review and is never reclaimed', async () => {
  const boundary = serviceBoundary({ unknownProvider: true });
  assert.equal((await boundary.h.mail.dispatchPerformanceReviewMailOutbox()).held, 1);
  assert.equal(boundary.state, 'needs_review');
  await boundary.h.mail.dispatchPerformanceReviewMailForReview(ids.review);
  assert.equal(boundary.providers, 1); assert.equal(boundary.h.requests.length, 1); assert.equal(boundary.h.logs.length, 0);
});
