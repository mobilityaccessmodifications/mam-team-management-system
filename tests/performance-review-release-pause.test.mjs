import assert from 'node:assert/strict';
import test from 'node:test';
import { productionActionHarness } from './performance-review-production-ui-fixture.mjs';
import { actorId, personId, operationId, reviewId, review, start, mutation } from './performance-review-backend-fixtures.mjs';
import { capabilities, loadModule } from './helpers/unified-role-harness.mjs';
import { loadMailHarness, environment, fixture, ids, request, ack, origin, readyHook } from './helpers/performance-review-mail-harness.mjs';

async function withFlags(pause, run) {
  const keys = ['MAM_PERFORMANCE_REVIEW_ENABLED', 'PERFORMANCE_REVIEW_RELEASE_PAUSED'];
  const previous = keys.map(key => process.env[key]);
  process.env.MAM_PERFORMANCE_REVIEW_ENABLED = 'true';
  if (pause === undefined) delete process.env.PERFORMANCE_REVIEW_RELEASE_PAUSED;
  else process.env.PERFORMANCE_REVIEW_RELEASE_PAUSED = pause;
  try { return await run(); }
  finally { keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }); }
}

function notificationFixture() {
  return { delivery_id: ids.delivery, review_id: ids.review, claim_token: ids.claim, payload: {
    event: 'started', eventKey: `performance-review:${ids.review}:started`, reviewId: ids.review,
    reviewCode: 'PR-2026-1', cycle: '2026', dueDate: '2026-11-30', recipient: 'synthetic@example.com',
    employeeName: 'Synthetic Employee', managerName: 'Synthetic Manager',
  } };
}

const mailEnvironment = pause => environment({ PERFORMANCE_REVIEW_RELEASE_PAUSED: pause,
  MAM_N8N_LEAVE_WEBHOOK_ORIGIN: origin, MAM_N8N_LEAVE_WEBHOOK_SECRET: 'synthetic-notification-secret-0123456789abcdef' });

function deliveryHarness(kind, pause, pauseDuringClaim = false) {
  let h;
  h = loadMailHarness({ env: mailEnvironment(pause), rpc(name) {
    if (name === (kind === 'final' ? 'claim_performance_review_mail' : 'claim_performance_review_notifications')) {
      if (pauseDuringClaim) h.env.PERFORMANCE_REVIEW_RELEASE_PAUSED = 'true';
      return { data: [kind === 'final' ? fixture() : notificationFixture()], error: null };
    }
    assert.equal(name, kind === 'final' ? 'finish_performance_review_mail' : 'finish_performance_review_notification');
    return { data: true, error: null };
  }, fetch(_url, init) {
    const wire = JSON.parse(init.body);
    return kind === 'final' ? ack(wire) : Response.json({ ok: true, sent: true, alreadySent: false,
      eventKey: wire.eventKey, actualRecipient: wire.recipient, actualCcRecipients: '',
      providerReceipt: { accepted: true, messageId: null, requestId: null, statusCode: 202 } });
  } });
  return h;
}

async function home() {
  const { default: Home } = loadModule('src/app/page.tsx', {
    '@/components/leave-demo': { LeaveDemo: 'LeaveDemo' },
    '@/components/role-permission-recovery': { RolePermissionRecovery: 'RolePermissionRecovery' },
    '@/lib/check-in-register': { getCheckInResourceLinks: () => ({}) },
    '@/lib/supabase/config': { isSupabaseConfigured: () => true },
    '@/lib/supabase/server': { createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: { id: actorId } }, error: null }) },
      rpc: async name => {
        assert.ok(['get_portal_role_capabilities', 'can_view_subscription_review_calendar'].includes(name));
        return { data: name === 'get_portal_role_capabilities' ? [capabilities('employee', personId)] : false, error: null };
      },
    }) },
    'next/navigation': { redirect: path => { throw Error('Unexpected redirect:' + path); } },
  });
  return Home({ searchParams: Promise.resolve({ view: 'people', tab: 'performance' }) });
}

test('exact release pause hides the Performance entry and rejects all six actions before auth or RPC', async () => withFlags('true', async () => {
  const tree = await home();
  assert.equal(tree.type, 'LeaveDemo');
  assert.equal(tree.props.performanceReviewEnabled, false);
  assert.equal(tree.props.authActorId, actorId);
  const h = productionActionHarness();
  for (const result of [await h.actions.loadPerformanceReviews(), await h.actions.loadPerformanceReviewMeetingInvitationStatus(reviewId),
    await h.actions.startPerformanceReview(start()), await h.actions.mutatePerformanceReview(mutation()),
    await h.actions.reconcilePerformanceReviewOperation({ operationId, reviewId }), await h.actions.getPerformanceReviewDocument(reviewId)]) {
    assert.deepEqual(result, { ok: false, code: 'unavailable', uncertain: false, message: 'Performance reviews are not available.' });
  }
  assert.equal(h.authCalls(), 0);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.registrations, []);
  assert.deepEqual(h.dispatches, []);
  assert.deepEqual(h.notificationDispatches, []);
}));

test('absent or nontrue pause preserves feature-enabled SSR and native workspace loading', async () => {
  for (const flag of [undefined, 'false', 'TRUE', '1', '']) await withFlags(flag, async () => {
    assert.equal((await home()).props.performanceReviewEnabled, true);
    const data = { viewerContext: { actorUserId: actorId, personId, role: 'employee', displayName: 'Synthetic viewer' }, reviews: [review()], startablePeople: [] };
    const h = productionActionHarness({ role: 'employee', response: { data, error: null, status: 200 } });
    assert.deepEqual(await h.actions.loadPerformanceReviews(), { ok: true, data });
    assert.equal(h.authCalls(), 1);
    assert.deepEqual(h.business(), [{ name: 'performance_review_workspace', args: undefined }]);
  });
});

test('release pause stops both direct and cron dispatchers before client creation, claim, or transport', async () => {
  const h = loadMailHarness({ env: mailEnvironment('true') });
  const notifications = h.load('src/lib/performance-review-notifications.ts');
  assert.deepEqual(await h.mail.dispatchPerformanceReviewMailOutbox(ids.review), { ok: true, code: 'disabled', claimed: 0, providerAccepted: 0, held: 0 });
  assert.deepEqual(await notifications.dispatchPerformanceReviewNotifications(ids.review), { ok: true, code: 'disabled', claimed: 0, sent: 0, held: 0 });
  await h.mail.dispatchPerformanceReviewMailForReview(ids.review);
  await notifications.dispatchPerformanceReviewNotificationsForReview(ids.review);
  for (const query of ['', '?notifications=1']) {
    const response = await h.route().GET(request('GET', undefined, { query }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).code, 'disabled');
  }
  assert.equal(h.clients, 0);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.logs, []);
});

test('default dispatch remains live and a pause arriving after claim still finishes the existing send', async () => {
  for (const kind of ['final', 'notification']) for (const [pause, pauseDuringClaim] of [[undefined, false], ['false', false], [undefined, true]]) {
    const h = deliveryHarness(kind, pause, pauseDuringClaim);
    const result = kind === 'final' ? await h.mail.dispatchPerformanceReviewMailOutbox(ids.review)
      : await h.load('src/lib/performance-review-notifications.ts').dispatchPerformanceReviewNotifications(ids.review);
    assert.deepEqual(result, { ok: true, code: 'processed', claimed: 1, [kind === 'final' ? 'providerAccepted' : 'sent']: 1, held: 0 });
    assert.equal(h.calls.length, 2);
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.rpcRetries, [false, false]);
    assert.deepEqual(h.logs, []);
  }
});

test('paused live mode keeps old begin, finish, and both readiness callbacks available to drain claims', async () => {
  const h = loadMailHarness({ env: mailEnvironment('true'), rpc: (name, args) => {
    assert.deepEqual(args, { p_delivery_id: ids.delivery, p_claim_token: ids.claim, p_attachment_sha256: 'a'.repeat(64),
      ...(name === 'begin_performance_review_manager_mail' ? { p_recipient: 'manager@mobilityaccess.com.au' } : { p_outcome: 'provider_accepted' }) });
    assert.ok(['begin_performance_review_manager_mail', 'finish_performance_review_mail'].includes(name));
    return { data: true, error: null };
  }, fetch: (url, init) => { assert.equal(url, readyHook); assert.equal(init.method, 'GET'); return Response.json({ ok: true, ready: true }); } });
  const route = h.route();
  const common = { deliveryId: ids.delivery, claimToken: ids.claim, attachmentSha256: 'a'.repeat(64) };
  for (const [body, expected] of [[{ phase: 'begin', ...common, recipient: 'manager@mobilityaccess.com.au' }, { ok: true, allowed: true }],
    [{ phase: 'finish', ...common, outcome: 'provider_accepted' }, { ok: true, recorded: true }],
    [{ phase: 'readiness' }, { ok: true, ready: true }]]) {
    const response = await route.POST(request('POST', body));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expected);
  }
  const ready = await route.GET(request('GET', undefined, { query: '?readiness=1' }));
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { ok: true, configured: true, ready: true });
  assert.deepEqual(h.calls.map(call => call.name), ['begin_performance_review_manager_mail', 'finish_performance_review_mail']);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.logs, []);
});
