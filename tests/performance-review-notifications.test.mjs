import assert from 'node:assert/strict';
import test from 'node:test';
import { productionActionHarness, enabled } from './performance-review-production-ui-fixture.mjs';
import { operationId, reviewId, review, start, mutation } from './performance-review-backend-fixtures.mjs';
import { loadMailHarness, ids, environment, origin, request } from './helpers/performance-review-mail-harness.mjs';

const env = () => environment({ MAM_N8N_LEAVE_WEBHOOK_ORIGIN: origin, MAM_N8N_LEAVE_WEBHOOK_SECRET: 'synthetic-notification-secret-0123456789abcdef' });
function fixture(event = 'started') {
  return { delivery_id: ids.delivery, review_id: ids.review, claim_token: ids.claim, payload: {
    event, eventKey: `performance-review:${ids.review}:${event}`, reviewId: ids.review,
    reviewCode: 'PR-2026-1', cycle: '2026', dueDate: '2026-11-30', recipient: 'synthetic@example.com', employeeName: 'Synthetic Employee', managerName: 'Synthetic Manager',
  } };
}
const receipt = p => ({ ok: true, sent: true, alreadySent: false, eventKey: p.eventKey, actualRecipient: p.recipient,
  actualCcRecipients: '', providerReceipt: { accepted: true, messageId: null, requestId: null, statusCode: 202 } });

test('both future review notifications use DB recipients, isolated webhook, durable receipts and no private content', async () => {
  for (const event of ['started', 'self-submitted']) {
    const row = fixture(event); let wire;
    row.payload.employeeName = 'x'.repeat(8000); row.payload.managerName = 'Synthetic\tManager\r\nName';
    const h = loadMailHarness({ env: env(), rpc(name, args) {
      if (name === 'claim_performance_review_notifications') { assert.deepEqual(args, { p_review_id: ids.review, p_limit: 1 }); return { data: [row], error: null }; }
      assert.equal(name, 'finish_performance_review_notification'); assert.equal(args.p_delivered, true); assert.equal(args.p_claim_token, ids.claim); return { data: true, error: null };
    }, fetch(url, init) {
      assert.equal(String(url), origin + '/webhook/mam-people-hub-performance-review-notifications-v1');
      assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
      wire = JSON.parse(init.body); assert.deepEqual(wire, { version: 1, ...row.payload, claimToken: ids.claim });
      return Response.json(receipt(wire));
    } });
    assert.deepEqual(await h.load('src/lib/performance-review-notifications.ts').dispatchPerformanceReviewNotifications(ids.review), { ok: true, code: 'processed', claimed: 1, sent: 1, held: 0 });
    assert.equal(h.requests.length, 1); assert.deepEqual(h.rpcRetries, [false, false]); assert.deepEqual(h.logs, []);
    assert.doesNotMatch(JSON.stringify(wire), /managerNote|selfAnswers|managerAnswers|ratings|attachment/);
  }
});

test('notification worker holds unknown provider results without replay or success claims', async () => {
  for (const mode of ['timeout', 'wrong-recipient', 'private-field', 'wrong-event', 'bad-evidence', 'redirect']) {
    const row = fixture(); let state = 'queued';
    const h = loadMailHarness({ env: env(), rpc(name, args) {
      if (name === 'claim_performance_review_notifications') { const rows = state === 'queued' ? [row] : []; state = 'claimed'; return { data: rows, error: null }; }
      assert.equal(args.p_delivered, false); state = 'needs_review'; return { data: true, error: null };
    }, fetch(_url, init) {
      if (mode === 'timeout') throw Error('SYNTHETIC-PRIVATE-SECRET');
      const p = JSON.parse(init.body), r = receipt(p);
      if (mode === 'wrong-recipient') r.actualRecipient = 'other@example.com';
      if (mode === 'private-field') r.managerNote = 'PRIVATE';
      if (mode === 'wrong-event') r.eventKey += '-other';
      if (mode === 'bad-evidence') r.providerReceipt.statusCode = 200;
      return mode === 'redirect' ? new Response('', { status: 302 }) : Response.json(r);
    } });
    const service = h.load('src/lib/performance-review-notifications.ts');
    assert.equal((await service.dispatchPerformanceReviewNotifications()).held, 1);
    assert.equal(state, 'needs_review');
    assert.equal((await service.dispatchPerformanceReviewNotifications()).claimed, 0);
    assert.equal(h.requests.length, 1); assert.deepEqual(h.logs, []);
  }
});

test('notification worker rejects private or foreign claims and stays inert when disabled or misconfigured', async () => {
  for (const patch of [{ review_id: ids.claim }, { payload: { ...fixture().payload, managerNote: 'PRIVATE' } }, { payload: { ...fixture().payload, recipient: 'a@example.com,b@example.com' } }]) {
    const h = loadMailHarness({ env: env(), rpc: () => ({ data: [{ ...fixture(), ...patch }], error: null }) });
    const r = await h.load('src/lib/performance-review-notifications.ts').dispatchPerformanceReviewNotifications(ids.review);
    assert.equal(r.held, 1); assert.equal(h.requests.length, 0);
  }
  for (const patch of [{ PERFORMANCE_REVIEW_EMAIL_MODE: 'disabled' }, { MAM_N8N_LEAVE_WEBHOOK_ORIGIN: 'https://other.example' }, { MAM_SANDBOX_E2E: 'true' }]) {
    const h = loadMailHarness({ env: { ...env(), ...patch } });
    await h.load('src/lib/performance-review-notifications.ts').dispatchPerformanceReviewNotifications();
    assert.equal(h.clients, 0); assert.equal(h.requests.length, 0);
  }
});

test('protected notification drain is separate from Careers and rejects unauthenticated requests', async () => {
  const h = loadMailHarness({ env: env(), rpc(name) { assert.equal(name, 'claim_performance_review_notifications'); return { data: [], error: null }; } });
  assert.equal((await h.route().GET(request('GET', undefined, { query: '?notifications=1', bearer: 'wrong' }))).status, 401);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.route().GET(request('GET', undefined, { query: '?notifications=1' }))).status, 200);
  assert.equal(h.calls.length, 1); assert.equal(h.requests.length, 0);
});

test('only validated new review and self-submission receipts schedule future lifecycle notifications', async () => enabled(async () => {
  for (const existing of [false, true]) {
    const h = productionActionHarness({ response: { data: { committed: true, operationId, review: review('manager'), existing }, error: null, status: 200 } });
    assert.equal((await h.actions.startPerformanceReview(start())).ok, true);
    assert.equal(h.callbacks.length, existing ? 0 : 1);
    for (const callback of h.callbacks) await callback();
    assert.deepEqual(h.notificationDispatches, existing ? [] : [[reviewId]]);
    assert.deepEqual(h.dispatches, []);
  }
  const h = productionActionHarness({ role: 'employee', response: { data: { committed: true, operationId, review: review() }, error: null, status: 200 } });
  assert.equal((await h.actions.mutatePerformanceReview({ ...mutation(), command: 'submit_self', input: { answers: Array(12).fill('Synthetic completed self assessment') } })).ok, true);
  assert.equal(h.callbacks.length, 1); await h.callbacks[0]();
  assert.deepEqual(h.notificationDispatches, [[reviewId]]); assert.deepEqual(h.dispatches, []);
  const bad = productionActionHarness({ response: { data: { committed: true, operationId: ids.claim, review: review('manager'), existing: false }, error: null, status: 200 } });
  assert.equal((await bad.actions.startPerformanceReview(start())).ok, false); assert.equal(bad.callbacks.length, 0);
}));

test('new notification claims bind Careers CC and do not duplicate Careers as primary recipient', async () => {
  for (const recipient of ['synthetic@example.com', 'careers@mobilityaccess.com.au']) {
    for (const badReceipt of [false, true]) {
      const row = fixture(); row.payload.recipient = recipient;
      row.payload.cc = recipient === 'careers@mobilityaccess.com.au' ? '' : 'careers@mobilityaccess.com.au';
      const h = loadMailHarness({ env: env(), rpc(name, args) {
        if (name === 'claim_performance_review_notifications') return { data: [row], error: null };
        assert.equal(args.p_delivered, !badReceipt); return { data: true, error: null };
      }, fetch(_url, init) {
        const p = JSON.parse(init.body); assert.equal(p.cc, row.payload.cc);
        return Response.json({ ...receipt(p), actualCcRecipients: badReceipt ? 'other@example.com' : p.cc });
      } });
      const result = await h.load('src/lib/performance-review-notifications.ts').dispatchPerformanceReviewNotifications(ids.review);
      assert.equal(result.sent, badReceipt ? 0 : 1); assert.equal(result.held, badReceipt ? 1 : 0);
    }
  }
});

test('new notification claims reject missing required Careers CC and arbitrary CC before webhook dispatch', async () => {
  for (const cc of ['', 'other@example.com', null, ['careers@mobilityaccess.com.au']]) {
    const row = fixture(); row.payload.cc = cc;
    const h = loadMailHarness({ env: env(), rpc: () => ({ data: [row], error: null }) });
    assert.equal((await h.load('src/lib/performance-review-notifications.ts').dispatchPerformanceReviewNotifications()).held, 1);
    assert.equal(h.requests.length, 0);
  }
});
