import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server.js';
import { loadModule, deferred } from './helpers/contact-lifetime-harness.mjs';
import { productionActionHarness, enabled, actorId, personId, managerId, reviewId } from './performance-review-production-ui-fixture.mjs';
import { loadMailProxyHarness } from './helpers/performance-review-mail-proxy-harness.mjs';

const endpoint = 'https://portal.example.test/api/performance-reviews/meeting-invitation-status';
const routeFor = actions => loadModule('src/app/api/performance-reviews/meeting-invitation-status/route.ts', { '@/app/performance-reviews/actions': actions });
const { ROLE_CAPABILITY_FIELDS } = loadModule('src/lib/portal-role-capabilities.ts');
function capabilities(role, id) {
  return [{ app_role: role, person_id: id, account_status: 'active',
    ...Object.fromEntries(ROLE_CAPABILITY_FIELDS.map(key => [key, role === 'system_admin' && ['is_super_admin', 'can_change_employee_view'].includes(key)])) }];
}
function uncached(response) {
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store, max-age=0');
  assert.equal(response.headers.get('Vary'), 'Cookie');
}
function noMail(h) { assert.equal(h.registrations.length + h.dispatches.length + h.notificationDispatches.length, 0); }

test('invitation status reads only the exact authorized receipt boolean for Manager, Admin and P0', async () => enabled(async () => {
  for (const role of ['manager', 'admin', 'system_admin']) for (const sent of [false, true]) {
    const h = productionActionHarness({ role, response: { data: { reviewId, sent }, error: null, status: 200 } });
    const result = await h.actions.loadPerformanceReviewMeetingInvitationStatus(reviewId);
    assert.deepEqual(result, { ok: true, reviewId, sent });
    assert.equal(h.authCalls(), 1);
    assert.deepEqual(h.business(), [{ name: 'performance_review_meeting_invitation_status', args: { p_review_id: reviewId, p_person_id: null } }]);
    noMail(h);
  }
}));

test('invitation status requires P0 delegation and a Manager target for employee previews', async () => enabled(async () => {
  for (const [actorRole, targetRole, allowed] of [['system_admin', 'manager', true], ['system_admin', 'employee', false], ['system_admin', 'admin', false], ['admin', 'manager', false], ['manager', 'manager', false]]) {
    const calls = [];
    const h = productionActionHarness({ client: {
      auth: { getUser: async () => ({ data: { user: { id: actorId } }, error: null }) },
      rpc: async (name, args) => {
        calls.push({ name, args });
        if (name === 'get_portal_role_capabilities') return { data: args.p_person_id === null ? capabilities(actorRole, actorRole === 'system_admin' ? null : personId) : capabilities(targetRole, managerId), error: null, status: 200 };
        assert.equal(name, 'performance_review_meeting_invitation_status');
        return { data: { reviewId, sent: true }, error: null, status: 200 };
      },
    } });
    const result = await h.actions.loadPerformanceReviewMeetingInvitationStatus(reviewId, managerId);
    assert.equal(result.ok, allowed);
    if (allowed) assert.deepEqual(calls.at(-1), { name: 'performance_review_meeting_invitation_status', args: { p_review_id: reviewId, p_person_id: managerId } });
    else { assert.equal(result.code, 'forbidden'); assert.ok(calls.every(call => call.name === 'get_portal_role_capabilities')); }
    noMail(h);
  }
}));

test('invitation status fails closed without leaking provider fields or treating a save as delivery', async () => {
  for (const flag of ['false', 'TRUE', '']) await enabled(async () => {
    const h = productionActionHarness();
    assert.equal((await h.actions.loadPerformanceReviewMeetingInvitationStatus(reviewId)).code, 'unavailable');
    assert.equal(h.authCalls(), 0); assert.equal(h.calls.length, 0);
  }, flag);
  await enabled(async () => {
    for (const args of [['bad'], [null], [reviewId, 'bad'], [reviewId, null]]) {
      const h = productionActionHarness();
      assert.equal((await h.actions.loadPerformanceReviewMeetingInvitationStatus(...args)).code, 'invalid');
      assert.equal(h.authCalls(), 0);
    }
    for (const role of ['employee', 'account']) {
      const h = productionActionHarness({ role });
      assert.equal((await h.actions.loadPerformanceReviewMeetingInvitationStatus(reviewId)).code, 'forbidden');
      assert.equal(h.business().length, 0);
    }
    for (const options of [
      { signedIn: false }, { canonicalError: { code: '42501', message: 'PRIVATE' } },
      { rpcThrows: true }, { response: { data: { reviewId, sent: true }, error: null, status: 500 } },
      ...[null, true, { reviewId: personId, sent: true }, { reviewId, sent: 'true' }, { reviewId, sent: true, recipient: 'PRIVATE' }, { reviewId, managerCompletedAt: '2026-10-21T00:00:00Z' }].map(data => ({ response: { data, error: null, status: 200 } })),
      { response: { data: null, error: { code: '42501', message: 'PRIVATE' }, status: 403 } },
    ]) {
      const h = productionActionHarness(options);
      const result = await h.actions.loadPerformanceReviewMeetingInvitationStatus(reviewId);
      assert.equal(result.ok, false); assert.equal(result.uncertain, false);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE|recipient|managerCompletedAt/);
      noMail(h);
    }
  });
});

test('invitation status GET is private, uncached and rejects authority or duplicate query fields', async () => enabled(async () => {
  for (const query of ['', '?reviewId=bad', `?reviewId=${reviewId}&reviewId=${reviewId}`, `?reviewId=${reviewId}&previewPersonId=${personId}&previewPersonId=${managerId}`, `?reviewId=${reviewId}&actorUserId=${actorId}`, `?reviewId=${reviewId}&role=system_admin`, `?reviewId=${reviewId}&previewPersonId=`]) {
    const h = productionActionHarness();
    const response = await routeFor(h.actions).GET(new Request(endpoint + query));
    assert.equal(response.status, 400, query); uncached(response);
    assert.equal((await response.json()).code, 'invalid');
    assert.equal(h.authCalls(), 0); assert.equal(h.business().length, 0);
  }
  const h = productionActionHarness({ response: { data: { reviewId, sent: true }, error: null, status: 200 } });
  const route = routeFor(h.actions);
  assert.deepEqual(Object.keys(route).sort(), ['GET', 'dynamic']); assert.equal(route.dynamic, 'force-dynamic');
  const response = await route.GET(new Request(endpoint + '?reviewId=' + reviewId));
  assert.equal(response.status, 200); uncached(response);
  assert.deepEqual(await response.json(), { ok: true, reviewId, sent: true }); noMail(h);
  const unavailable = await routeFor({ loadPerformanceReviewMeetingInvitationStatus: async () => { throw Error('PRIVATE'); } }).GET(new Request(endpoint + '?reviewId=' + reviewId));
  assert.equal(unavailable.status, 503); uncached(unavailable); assert.doesNotMatch(await unavailable.text(), /PRIVATE/);
}));

test('invitation status reaches its session guard while adjacent unauthenticated paths still redirect', async () => enabled(async () => {
  const h = loadMailProxyHarness();
  const response = await h.proxy(new NextRequest(endpoint));
  assert.equal(response.headers.get('x-middleware-next'), '1');
  const denied = await routeFor(productionActionHarness({ signedIn: false }).actions).GET(new Request(endpoint + '?reviewId=' + reviewId));
  assert.equal(denied.status, 401); uncached(denied);
  for (const suffix of ['/', '/extra', '-other']) assert.equal((await h.proxy(new NextRequest(endpoint + suffix))).status, 307);
}));

test('status client validates the review and delivery boolean without waiting for unrelated mutations', async t => {
  const mutation = deferred(); let finished = false; void mutation.promise.then(() => { finished = true; });
  const requests = [];
  let data = { ok: true, reviewId, sent: true }, status = 200;
  t.mock.method(globalThis, 'fetch', async (url, options) => { requests.push({ url, options }); return Response.json(data, { status }); });
  const client = loadModule('src/lib/performance-review-load.ts');
  try {
    assert.deepEqual(await client.loadPerformanceReviewMeetingInvitationStatus(reviewId, managerId), data);
    assert.equal(finished, false);
    assert.deepEqual(requests[0], { url: '/api/performance-reviews/meeting-invitation-status?reviewId=' + reviewId + '&previewPersonId=' + managerId, options: { credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } } });
    for (const bad of [null, {}, { ok: true, reviewId: personId, sent: true }, { ok: true, reviewId, sent: 'true' }]) {
      data = bad; await assert.rejects(client.loadPerformanceReviewMeetingInvitationStatus(reviewId), /Invitation status could not be loaded/);
    }
    data = { ok: true, reviewId, sent: true }; status = 503;
    await assert.rejects(client.loadPerformanceReviewMeetingInvitationStatus(reviewId), /Invitation status could not be loaded/);
    data = { ok: false, code: 'unauthenticated', uncertain: false, message: 'Sign in before using performance reviews.' }; status = 401;
    assert.deepEqual(await client.loadPerformanceReviewMeetingInvitationStatus(reviewId), data);
  } finally { mutation.resolve(); }
});
