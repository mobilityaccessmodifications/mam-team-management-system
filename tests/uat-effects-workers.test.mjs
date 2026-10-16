import assert from 'node:assert/strict';
import test from 'node:test';
import { apiRequest, fixture, ok, PERSON, SECRET, UNAVAILABLE } from './uat-effects-fixtures.mjs';

const workers = [
  ['src/lib/leave-notification-outbox.ts', 'dispatchLeaveNotificationOutbox', [PERSON], { ok: false, code: 'not_configured', claimed: 0, sent: 0, failed: 0 }, 'claim_leave_notification_outbox'],
  ['src/lib/leave-notification-outbox.ts', 'dispatchLeaveNotificationsForRequest', [PERSON], undefined, 'claim_leave_notification_outbox'],
  ['src/lib/leave-notification-outbox.ts', 'dispatchPayrollComparisonAlerts', [], { ok: false, claimed: 0, sent: 0 }, 'claim_payroll_comparison_alerts'],
  ['src/lib/subscription-request-mail.ts', 'dispatchSubscriptionRequestMail', [PERSON], { ok: false, claimed: 0, sent: 0 }, 'claim_subscription_request_mail'],
  ['src/lib/subscription-review-mail.ts', 'dispatchSubscriptionReviewMail', [], { ok: false, selected: 0, sent: 0 }, 'list_subscription_review_mail'],
];

for (const [path, name, args, expected, rpc] of workers) {
  test(`UAT direct worker ${name} performs no admin/claim/provider work`, async () => {
    const f = fixture();
    try {
      const worker = await f.load(path);
      let result;
      let thrown;
      try { result = await worker[name](...args); } catch (error) { thrown = error; }
      f.observe(name, { result, threw: Boolean(thrown) });
      f.assertZero(name);
      assert.equal(thrown, undefined);
      assert.deepEqual(result, expected);
    } finally { f.cleanup(); }
  });

  test(`ordinary direct worker ${name} retains its database queue path`, async () => {
    const seen = [];
    const f = fixture({ uat: false, admin: { rpc: async (name, args) => { seen.push([name, args]); return ok([]); } } });
    try {
      const worker = await f.load(path);
      const result = await worker[name](...args);
      assert.deepEqual(seen.map(([name]) => name), [rpc]);
      assert.deepEqual(f.calls, ['admin']);
      if (expected !== undefined) { assert.equal(result.ok, true); assert.equal(result.sent, 0); }
    } finally { f.cleanup(); }
  });
}

for (const [method, action] of [['GET', null], ['POST', 'reserve'], ['POST', 'confirm']]) {
  test(`UAT direct receipt ${method} ${action ?? 'status'} rejects before supplied RPC is used`, async () => {
    const f = fixture();
    try {
      const { handleNotificationReceipts } = await f.load('src/lib/notification-receipts.ts');
      let request = apiRequest('src/app/api/internal/integrations/notifications/receipts/route.ts', method);
      if (action === 'confirm') request = new Request(request.url, { method, headers: request.headers, body: JSON.stringify({ action, eventKey: `onboarding-credential:${PERSON}`, recipient: 'synthetic@example.invalid', cc: '', deliveryToken: PERSON, providerReceipt: { accepted: true, messageId: 'synthetic', requestId: null, statusCode: 202 } }) });
      const response = await handleNotificationReceipts(request, SECRET, (...args) => f.hit('receipt.rpc', ...args));
      f.observe('direct receipt ' + method, { status: response.status });
      f.assertZero('direct receipt ' + method);
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: UNAVAILABLE });
    } finally { f.cleanup(); }
  });
}

test('ordinary direct receipt read retains exact status schema', async () => {
  const seen = [];
  const f = fixture({ uat: false });
  try {
    const { handleNotificationReceipts } = await f.load('src/lib/notification-receipts.ts');
    const response = await handleNotificationReceipts(apiRequest('src/app/api/internal/integrations/notifications/receipts/route.ts', 'GET'), SECRET, async (name, args) => { seen.push([name, args]); return ok({ version: 1, ready: true }); });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { version: 1, ready: true });
    assert.deepEqual(seen, [['notification_delivery_store_status', {}]]);
  } finally { f.cleanup(); }
});
