import assert from 'node:assert/strict';
import test from 'node:test';
import { productionActionHarness, enabled, actorId, personId, managerId, reviewId, review } from './performance-review-production-ui-fixture.mjs';
import { document } from './performance-review-backend-fixtures.mjs';
import { loadModule } from './helpers/contact-lifetime-harness.mjs';

const { ROLE_CAPABILITY_FIELDS } = loadModule('src/lib/portal-role-capabilities.ts');
function capabilities(role, id) {
  return [{ app_role: role, person_id: id, account_status: 'active',
    ...Object.fromEntries(ROLE_CAPABILITY_FIELDS.map(key => [key, role === 'system_admin' && ['is_super_admin', 'can_change_employee_view'].includes(key)])) }];
}
function readonly(row) {
  return { ...row, capabilities: Object.fromEntries(Object.keys(row.capabilities).map(key => [key, key === 'downloadDocument'])) };
}
function harness({ actorRole = 'system_admin', targetRole = 'manager', targetId = managerId, targetError = null, response, signedIn = true } = {}) {
  const calls = [];
  const audience = ['admin', 'system_admin'].includes(targetRole) ? 'admin' : targetRole === 'manager' ? 'manager' : 'employee';
  const data = { viewerContext: { actorUserId: actorId, personId: targetId, role: targetRole, displayName: 'Synthetic target' },
    reviews: [readonly(review(audience))], startablePeople: targetRole === 'manager' ? [review().employee] : [] };
  const h = productionActionHarness({ client: {
    auth: { getUser: async () => ({ data: { user: signedIn ? { id: actorId } : null }, error: null }) },
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === 'get_portal_role_capabilities') return args.p_person_id === null
        ? { data: capabilities(actorRole, actorRole === 'system_admin' ? null : personId), error: null, status: 200 }
        : { data: capabilities(targetRole, targetId), error: targetError, status: 200 };
      assert.ok(['performance_review_workspace_for_preview', 'performance_review_workspace_for_delegate', 'get_performance_review_document_for_preview'].includes(name), 'Preview must not fall back to the real P0 projection');
      return { data: response === undefined ? data : typeof response === 'function' ? response(data) : response, error: null, status: 200 };
    },
  } });
  return { ...h, calls, data, business: () => calls.filter(c => c.name !== 'get_portal_role_capabilities') };
}

test('P0 target reads use real actor and route Manager delegation separately from read-only roles', async () => enabled(async () => {
  for (const targetRole of ['employee', 'account', 'manager', 'admin', 'system_admin']) {
    const targetId = ['manager', 'admin', 'system_admin'].includes(targetRole) ? managerId : personId;
    const h = harness({ targetRole, targetId });
    assert.deepEqual(await h.actions.loadPerformanceReviews(targetId), { ok: true, data: h.data });
    assert.deepEqual(h.calls.map(c => c.name), ['get_portal_role_capabilities', 'get_portal_role_capabilities', targetRole === 'manager' ? 'performance_review_workspace_for_delegate' : 'performance_review_workspace_for_preview']);
    assert.deepEqual(h.business()[0].args, { p_person_id: targetId });
    assert.equal(h.registrations.length + h.dispatches.length + h.notificationDispatches.length, 0);
  }
}));

test('preview rejects non-P0 actors, invalid targets and unavailable target accounts without business RPCs', async () => enabled(async () => {
  for (const actorRole of ['employee', 'account', 'manager', 'admin']) {
    const h = harness({ actorRole });
    assert.equal((await h.actions.loadPerformanceReviews(managerId)).code, 'forbidden');
    assert.equal((await h.actions.getPerformanceReviewDocument(reviewId, managerId)).code, 'forbidden');
    assert.equal(h.business().length, 0);
    assert.ok(h.calls.every(c => c.args.p_person_id === null));
  }
  for (const value of [null, '', 'bad', {}, { personId }]) {
    const h = harness();
    assert.equal((await h.actions.loadPerformanceReviews(value)).code, 'invalid');
    assert.equal((await h.actions.getPerformanceReviewDocument(reviewId, value)).code, 'invalid');
    assert.equal(h.calls.length, 0);
  }
  const denied = harness({ targetError: { code: '42501', message: 'PRIVATE' } });
  assert.equal((await denied.actions.loadPerformanceReviews(managerId)).code, 'forbidden');
  assert.equal(denied.business().length, 0);
  const missing = harness({ signedIn: false });
  assert.equal((await missing.actions.loadPerformanceReviews(managerId)).code, 'unauthenticated');
  assert.equal(missing.calls.length, 0);
}));

test('preview parser rejects P0 fallback, another target, leaked fields and unauthorized write capabilities', async () => enabled(async () => {
  const transforms = [
    data => ({ ...data, viewerContext: { ...data.viewerContext, personId } }),
    data => ({ ...data, viewerContext: { ...data.viewerContext, role: 'system_admin', personId: null } }),
    data => ({ ...data, viewerContext: { ...data.viewerContext, actorUserId: personId } }),
    data => ({ ...data, reviews: [{ ...data.reviews[0], manager: { ...data.reviews[0].manager, id: personId } }] }),
  ];
  for (const transform of transforms) {
    const h = harness({ response: transform });
    assert.equal((await h.actions.loadPerformanceReviews(managerId)).code, 'unavailable');
  }
  for (const key of ['saveSelf', 'submitSelf']) {
    const h = harness({ response: data => ({ ...data, reviews: [{ ...data.reviews[0], capabilities: { ...data.reviews[0].capabilities, [key]: true } }] }) });
    assert.equal((await h.actions.loadPerformanceReviews(managerId)).code, 'unavailable');
  }
  for (const key of ['saveManager', 'completeManager', 'saveMeeting', 'submitReview']) {
    const h = harness({ targetRole: 'admin', targetId: personId, response: data => ({ ...data, reviews: [{ ...data.reviews[0], capabilities: { ...data.reviews[0].capabilities, [key]: true } }] }) });
    assert.equal((await h.actions.loadPerformanceReviews(personId)).code, 'unavailable');
  }
  const leaked = harness({ targetRole: 'employee', targetId: personId, response: data => ({ ...data, reviews: [{ ...data.reviews[0], managerNote: 'PRIVATE' }] }) });
  assert.equal((await leaked.actions.loadPerformanceReviews(personId)).code, 'unavailable');
}));

test('preview Word reads use target-bound RPC and preserve employee field isolation', async () => enabled(async () => {
  for (const [targetRole, audience, targetId] of [['employee', 'employee', personId], ['account', 'employee', personId], ['manager', 'manager', managerId], ['admin', 'admin', managerId]]) {
    const doc = document(audience);
    const h = harness({ targetRole, targetId, response: doc });
    assert.deepEqual(await h.actions.getPerformanceReviewDocument(reviewId, targetId), { ok: true, document: doc });
    assert.deepEqual(h.business(), [{ name: 'get_performance_review_document_for_preview', args: { p_person_id: targetId, p_review_id: reviewId } }]);
    assert.equal(h.registrations.length + h.dispatches.length + h.notificationDispatches.length, 0);
  }
  for (const response of [document('manager'), { ...document(), managerNote: 'PRIVATE' }]) {
    const h = harness({ targetRole: 'employee', targetId: personId, response });
    assert.equal((await h.actions.getPerformanceReviewDocument(reviewId, personId)).code, 'unavailable');
  }
}));
