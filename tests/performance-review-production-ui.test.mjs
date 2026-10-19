import assert from 'node:assert/strict';
import test from 'node:test';
import { committedReceipt, enabled, finalInput, productionActionHarness, reviewId, review, mutation, operationId, actorId, personId, managerId, meeting } from './performance-review-production-ui-fixture.mjs';
import { document, start } from './performance-review-backend-fixtures.mjs';

test('validated final submit registers one after callback and dispatches only the exact committed review ID', async () => enabled(async () => {
  const receipt = committedReceipt();
  const h = productionActionHarness({ response: { data: receipt, error: null, status: 200 } });
  const result = await h.actions.mutatePerformanceReview(finalInput());
  assert.deepEqual(result, { ok: true, ...receipt });
  assert.equal(h.business().length, 1);
  assert.equal(h.registrations.length, 1);
  assert.equal(h.callbacks.length, 1);
  assert.deepEqual(h.dispatches, []);
  receipt.review.id = '30000000-0000-4000-8000-000000000099';
  receipt.review.managerNote = 'RETIRED-PRIVATE-NOTE';
  await h.callbacks[0]();
  assert.deepEqual(h.dispatches, [[reviewId]]);
  assert.equal(h.business().length, 1);
  assert.equal(h.registrations.length, 1);
}));

test('after registration failure preserves the committed result without a retry or private error', async () => enabled(async () => {
  const receipt = committedReceipt();
  const h = productionActionHarness({ response: { data: receipt, error: null, status: 200 }, afterThrows: true });
  const result = await h.actions.mutatePerformanceReview(finalInput());
  assert.deepEqual(result, { ok: true, ...receipt });
  assert.equal(h.registrations.length, 1);
  assert.deepEqual(h.callbacks, []);
  assert.deepEqual(h.dispatches, []);
  assert.equal(h.business().length, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-SYNTHETIC-SCHEDULER|uncertain|emailStatus/);
}));

test('dispatch rejection is contained after commit without resubmission or automatic retry', async () => enabled(async () => {
  const receipt = committedReceipt();
  const h = productionActionHarness({ response: { data: receipt, error: null, status: 200 }, dispatchRejects: true });
  const result = await h.actions.mutatePerformanceReview(finalInput());
  assert.deepEqual(result, { ok: true, ...receipt });
  assert.equal(h.registrations.length, 1);
  await assert.doesNotReject(h.callbacks[0]());
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.dispatches, [[reviewId]]);
  assert.equal(h.business().length, 1);
  assert.deepEqual(result, { ok: true, ...receipt });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-SYNTHETIC-MAIL|emailStatus/);
}));

test('production no-mail boundary rejects invalid, denied and mismatched final receipts without scheduling', async () => enabled(async () => {
  const receipt = committedReceipt();
  const wrongReview = { ...receipt.review, id: '30000000-0000-4000-8000-000000000099' };
  const cases = [
    [{ role: 'employee' }, 'forbidden', 0],
    [{ role: 'admin' }, 'forbidden', 0],
    [{ role: 'system_admin' }, 'forbidden', 0],
    [{ signedIn: false }, 'unauthenticated', 0],
    [{ canonicalError: { code: '42501' }, canonicalStatus: 403 }, 'forbidden', 0],
    [{ response: { data: receipt, error: null, status: 500 } }, 'uncertain', 1],
    [{ rpcThrows: true }, 'uncertain', 1],
    [{ response: { data: null, error: { code: 'PT409' }, status: 409 } }, 'conflict', 1],
    ...[null, { ...receipt, committed: false }, { ...receipt, operationId: actorId },
      { ...receipt, review: wrongReview }, { ...receipt, review: { ...receipt.review, manager: { id: personId, name: 'Synthetic other manager' } } },
      { ...receipt, private: 'PRIVATE-SYNTHETIC-RECEIPT' }, { ...receipt, review: { ...receipt.review, extra: true } }]
      .map(data => [{ response: { data, error: null, status: 200 } }, 'uncertain', 1]),
  ];
  for (const [options, code, count] of cases) {
    const h = productionActionHarness(options);
    const result = await h.actions.mutatePerformanceReview(finalInput());
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(h.business().length, count);
    assert.deepEqual(h.registrations, []);
    assert.deepEqual(h.callbacks, []);
    assert.deepEqual(h.dispatches, []);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-SYNTHETIC|managerNote|emailStatus/);
  }
  const h = productionActionHarness();
  assert.equal((await h.actions.mutatePerformanceReview({ ...finalInput(), input: { ...finalInput().input, held: false } })).code, 'invalid');
  assert.equal(h.authCalls(), 0);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.registrations, []);
}));

test('production boundary keeps drafts and reads silent while lifecycle notifications remain separate from Careers', async () => enabled(async () => {
  const managerInput = { answers: Array(12).fill('Synthetic evidence'), ratings: Array(12).fill('2 Meets expectations'), summary: 'Synthetic summary', overallRating: '2 Meets expectations', managerNote: 'PRIVATE-SYNTHETIC-NOTE' };
  for (const command of ['save_self', 'submit_self', 'save_manager', 'complete_manager', 'save_meeting']) {
    const self = command === 'save_self' || command === 'submit_self';
    const row = review(self ? 'employee' : 'manager');
    const h = productionActionHarness({ role: self ? 'employee' : 'manager', response: { data: { committed: true, operationId, review: row }, error: null, status: 200 } });
    const request = { ...mutation(), command, expectedRevision: self ? 'self:0' : 'manager:0:0', input: self ? { answers: Array(12).fill('Synthetic self') } : command === 'save_meeting' ? meeting : managerInput };
    assert.equal((await h.actions.mutatePerformanceReview(request)).ok, true, command);
    assert.equal(h.business().length, 1);
    assert.equal(h.registrations.length, command === 'submit_self' ? 1 : 0);
    for (const callback of h.callbacks) await callback();
    assert.deepEqual(h.notificationDispatches, command === 'submit_self' ? [[reviewId]] : []);
    assert.deepEqual(h.dispatches, []);
  }
  const managerReview = review('manager');
  const workspace = { viewerContext: { actorUserId: actorId, personId: managerId, role: 'manager', displayName: 'Synthetic manager' }, reviews: [managerReview], startablePeople: [] };
  for (const [action, args, data] of [
    ['startPerformanceReview', [start()], { committed: true, operationId, review: managerReview, existing: false }],
    ['loadPerformanceReviews', [], workspace],
    ['getPerformanceReviewDocument', [reviewId], document('manager')],
    ['reconcilePerformanceReviewOperation', [{ operationId, reviewId }], { status: 'committed', review: managerReview }],
    ['reconcilePerformanceReviewOperation', [{ operationId, reviewId }], { status: 'not_found', review: null }],
  ]) {
    const h = productionActionHarness({ response: { data, error: null, status: 200 } });
    assert.equal((await h.actions[action](...args)).ok, true, action);
    assert.equal(h.business().length, 1);
    assert.equal(h.registrations.length, action === 'startPerformanceReview' ? 1 : 0);
    for (const callback of h.callbacks) await callback();
    assert.deepEqual(h.notificationDispatches, action === 'startPerformanceReview' ? [[reviewId]] : []);
    assert.deepEqual(h.dispatches, []);
  }
  await enabled(async () => {
    const h = productionActionHarness();
    assert.equal((await h.actions.mutatePerformanceReview(finalInput())).ok, false);
    assert.equal(h.authCalls(), 0);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.registrations, []);
  }, 'false');
}));
