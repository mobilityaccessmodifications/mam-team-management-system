import assert from 'node:assert/strict';
import test from 'node:test';
import { productionActionHarness, enabled } from './performance-review-production-ui-fixture.mjs';
import { actorId, personId, managerId, reviewId, operationId, review, start, mutation } from './performance-review-backend-fixtures.mjs';
import { loadModule } from './helpers/contact-lifetime-harness.mjs';

const { ROLE_CAPABILITY_FIELDS } = loadModule('src/lib/portal-role-capabilities.ts');
const { parseWorkspace } = loadModule('src/lib/performance-review-rules.ts');
const otherManager = '20000000-0000-4000-8000-000000000003';
const managerInput = { ...mutation(), command: 'save_manager', expectedRevision: 'manager:1:0', input: { answers: Array(12).fill('Synthetic evidence'), ratings: Array(12).fill('2 Meets expectations'), summary: 'Synthetic summary', overallRating: '2 Meets expectations', managerNote: 'Synthetic private note' } };
function capabilities(role, id, privileged = true) {
  return [{ app_role: role, person_id: id, account_status: 'active', ...Object.fromEntries(ROLE_CAPABILITY_FIELDS.map(key => [key, privileged && role === 'system_admin' && ['is_super_admin', 'can_change_employee_view'].includes(key)])) }];
}
function harness({ actorRole = 'system_admin', targetRole = 'manager', targetId = managerId, privileged = true, response, error = null, status = 200 } = {}) {
  const calls = [];
  const result = productionActionHarness({ client: {
    auth: { getUser: async () => ({ data: { user: { id: actorId } }, error: null }) },
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === 'get_portal_role_capabilities') return { data: args.p_person_id === null ? capabilities(actorRole, actorRole === 'system_admin' ? null : personId, privileged) : capabilities(targetRole, targetId), error: null, status: 200 };
      assert.match(name, /_for_delegate$/);
      return { data: typeof response === 'function' ? response(name, args) : response, error, status };
    },
  } });
  return { ...result, calls, business: () => calls.filter(call => call.name !== 'get_portal_role_capabilities') };
}

test('P0 delegate creation binds the selected Manager and schedules only a new committed review notification', async () => enabled(async () => {
  for (const existing of [false, true]) {
    const receipt = { committed: true, operationId, review: review('manager'), existing };
    const h = harness({ response: receipt });
    assert.deepEqual(await h.actions.startPerformanceReview(start(), managerId), { ok: true, ...receipt });
    assert.deepEqual(h.business(), [{ name: 'start_performance_review_for_delegate', args: { p_person_id: managerId, p_operation_id: operationId, p_employee_person_id: personId, p_cycle: '2026', p_due_date: '2026-12-31' } }]);
    assert.deepEqual(h.calls.slice(0, 2).map(call => call.args.p_person_id), [null, managerId]);
    assert.equal(h.registrations.length, existing ? 0 : 1);
    for (const callback of h.callbacks) await callback();
    assert.equal(h.notificationDispatches.length, existing ? 0 : 1);
  }
}));

test('ordinary actors cannot call any delegated write or recovery even when the selected person is Manager', async () => enabled(async () => {
  for (const actorRole of ['employee', 'account', 'manager', 'admin']) {
    const h = harness({ actorRole });
    for (const result of [await h.actions.startPerformanceReview(start(), managerId), await h.actions.mutatePerformanceReview(managerInput, managerId), await h.actions.reconcilePerformanceReviewOperation({ operationId, reviewId }, managerId)]) assert.equal(result.code, 'forbidden');
    assert.equal(h.business().length, 0);
    assert.ok(h.calls.every(call => call.args.p_person_id === null));
  }
  const h = harness({ privileged: false });
  assert.equal((await h.actions.startPerformanceReview(start(), managerId)).code, 'forbidden');
  assert.equal(h.business().length, 0);
}));

test('P0 delegate rejects nonmanager, mismatched and malformed targets before business dispatch', async () => enabled(async () => {
  for (const targetRole of ['employee', 'account', 'admin', 'system_admin']) {
    const h = harness({ targetRole });
    for (const result of [await h.actions.startPerformanceReview(start(), managerId), await h.actions.mutatePerformanceReview(managerInput, managerId), await h.actions.reconcilePerformanceReviewOperation({ operationId, reviewId }, managerId)]) assert.equal(result.code, 'forbidden');
    assert.equal(h.business().length, 0);
  }
  const mismatch = harness({ targetId: otherManager });
  assert.equal((await mismatch.actions.startPerformanceReview(start(), managerId)).ok, false);
  assert.equal(mismatch.business().length, 0);
  for (const target of [null, '', 'bad', {}]) {
    const h = harness();
    for (const result of [await h.actions.startPerformanceReview(start(), target), await h.actions.mutatePerformanceReview(managerInput, target), await h.actions.reconcilePerformanceReviewOperation({ operationId, reviewId }, target)]) assert.equal(result.code, 'invalid');
    assert.equal(h.calls.length, 0);
  }
}));

test('delegate mutations cannot submit self answers and bind Manager writes and final mail to one target', async () => enabled(async () => {
  const denied = harness();
  assert.equal((await denied.actions.mutatePerformanceReview(mutation(), managerId)).code, 'forbidden');
  assert.equal(denied.business().length, 0);
  for (const command of ['save_manager', 'complete_manager']) {
    const receipt = { committed: true, operationId, review: review('manager') };
    const h = harness({ response: receipt });
    assert.equal((await h.actions.mutatePerformanceReview({ ...managerInput, command }, managerId)).ok, true);
    assert.equal(h.business()[0].name, 'mutate_performance_review_for_delegate');
    assert.equal(h.business()[0].args.p_person_id, managerId);
    assert.equal(h.registrations.length, 0);
  }
  const receipt = { committed: true, operationId, review: review('manager') };
  const h = harness({ response: receipt });
  const input = { operationId, reviewId, expectedRevision: 'manager:1:2', command: 'submit_review', input: { date: '2026-01-01', time: '10:00', duration: 30, mode: 'in_person', location: 'Synthetic room', notes: '', held: true } };
  assert.equal((await h.actions.mutatePerformanceReview(input, managerId)).ok, true);
  for (const callback of h.callbacks) await callback();
  assert.deepEqual(h.dispatches, [[reviewId]]);
  assert.deepEqual(h.notificationDispatches, []);
}));

test('delegate transport uncertainty never retries and malformed or other-Manager receipts never schedule mail', async () => enabled(async () => {
  for (const options of [
    { response: null },
    { response: { committed: true, operationId, existing: false, review: { ...review('manager'), manager: { id: otherManager, name: 'Synthetic other' } } } },
    { status: 500, error: { code: '42501' } },
  ]) {
    const h = harness(options);
    assert.equal((await h.actions.startPerformanceReview(start(), managerId)).code, 'uncertain');
    assert.equal(h.business().length, 1);
    assert.equal(h.registrations.length, 0);
  }
}));

test('delegate reconciliation uses a read-only target-bound RPC and rejects self or other-Manager rows', async () => enabled(async () => {
  const data = { status: 'committed', review: review('manager') };
  const h = harness({ response: data });
  assert.deepEqual(await h.actions.reconcilePerformanceReviewOperation({ operationId, reviewId }, managerId), { ok: true, data });
  assert.deepEqual(h.business(), [{ name: 'get_performance_review_operation_for_delegate', args: { p_person_id: managerId, p_operation_id: operationId, p_review_id: reviewId } }]);
  assert.equal(h.registrations.length, 0);
  for (const row of [review(), { ...review('manager'), manager: { id: otherManager, name: 'Synthetic other' } }]) {
    const bad = harness({ response: { status: 'committed', review: row } });
    assert.equal((await bad.actions.reconcilePerformanceReviewOperation({ operationId, reviewId }, managerId)).ok, false);
  }
}));

test('delegate workspace accepts only assigned manager writes while its own self assessment remains read-only', () => {
  const own = { ...review(), id: '30000000-0000-4000-8000-000000000002', employee: { ...review().employee, id: managerId }, capabilities: { saveSelf: false, submitSelf: false, downloadDocument: true } };
  const assigned = review('manager');
  const data = { viewerContext: { actorUserId: actorId, personId: managerId, role: 'manager', displayName: 'Synthetic Manager' }, reviews: [own, assigned], startablePeople: [assigned.employee] };
  assert.deepEqual(parseWorkspace(data, actorId, 'manager', managerId, 'manager_delegate'), data);
  assert.throws(() => parseWorkspace({ ...data, reviews: [{ ...own, capabilities: { ...own.capabilities, saveSelf: true } }, assigned] }, actorId, 'manager', managerId, 'manager_delegate'));
  assert.throws(() => parseWorkspace({ ...data, reviews: [{ ...assigned, manager: { id: otherManager, name: 'Synthetic other' } }] }, actorId, 'manager', managerId, 'manager_delegate'));
});
