import assert from 'node:assert/strict';
import test from 'node:test';
import { apiMethods, apiRequest, fixture, ok, PERSON, USER } from './uat-effects-fixtures.mjs';

const expectedRpc = {
  'analytics/v1': ['validate_analytics_api_key', 'analytics_dashboard_dataset'],
  'cron/check-in-reminders': ['claim_due_employee_check_in_reminders', 'claim_due_employee_check_in_review_notifications'],
  'cron/leave-accrual': ['refresh_employee_leave_accrual'],
  'cron/leave-attachment-cleanup': ['list_stale_leave_attachment_orphans', 'list_expired_payroll_balance_source_archives', 'prune_expired_leave_attachment_upload_intents', 'prune_expired_leave_attachment_upload_attempts'],
  'cron/leave-notifications': ['claim_leave_notification_outbox', 'claim_payroll_comparison_alerts'],
  'cron/leave-priority-reminders': ['claim_leave_priority_reminders', 'claim_due_payroll_balance_email_reminders'],
  'cron/new-starter-day-one': ['claim_due_new_starter_day_one_reminders'],
  'cron/onboarding-credentials': ['claim_due_onboarding_credentials'],
  'cron/openclaw-leave-cleanup': ['prune_openclaw_leave_state'],
  'cron/recovery': ['list_scheduled_employee_offboarding'],
  'cron/scheduled-offboarding': ['list_scheduled_employee_offboarding'],
  'cron/subscription-requests': ['claim_subscription_request_mail', 'list_subscription_review_mail'],
  'internal/integrations/openclaw/whatsapp-allowlist': ['openclaw_whatsapp_allowlist_snapshot_v2'],
  'internal/integrations/openclaw/leave': ['openclaw_leave_v3_snapshot'],
};
for (const { path, method } of apiMethods()) {
  test(`ordinary actual ${method} ${path} retains its configured path`, async () => {
    const seen = [];
    const short = path.replace('src/app/api/', '').replace('/route.ts', '');
    const expected = expectedRpc[short] ?? (short.endsWith('/receipts') ? [method === 'GET' ? 'notification_delivery_store_status' : 'reserve_notification_delivery'] : []);
    const admin = { rpc(name, args) {
      seen.push(name);
      assert.ok(expected.includes(name), 'Unexpected synthetic RPC ' + name);
      let data = [];
      if (name === 'validate_analytics_api_key') data = true;
      if (name === 'analytics_dashboard_dataset') data = { rows: [], total: 0 };
      if (name === 'refresh_employee_leave_accrual') data = 7;
      if (name.startsWith('prune_expired_leave_attachment')) data = 0;
      if (name === 'prune_openclaw_leave_state') data = { remaining: false };
      if (name === 'notification_delivery_store_status') data = { version: 1, ready: true };
      if (name === 'reserve_notification_delivery') data = { outcome: 'send', eventKey: args.p_event_key, deliveryToken: PERSON };
      if (name === 'openclaw_whatsapp_allowlist_snapshot_v2') data = { complete: true, schemaVersion: 2, rowCount: 0, contacts: [] };
      if (name === 'openclaw_leave_v3_snapshot') data = {
        complete: true, fingerprint: 'a'.repeat(64), receipt: null, submitted: null,
        rows: [{ personId: PERSON, userId: USER, company: 'mam', active: true, nodeKind: 'person', accountActive: true, phone: '+61400000000', country: 'AU', employmentType: 'full_time', fullName: 'Synthetic Fixture', phoneIdentityVersion: PERSON }],
      };
      const promise = Promise.resolve(ok(data));
      promise.abortSignal = () => promise;
      return promise;
    } };
    const f = fixture({ uat: false, admin, ports: {
      purge: async () => ({ phase: 'synthetic-inert-action-boundary' }),
      proof: async () => true,
    } });
    try {
      const handlers = await f.load(path);
      const response = await handlers[method](apiRequest(path, method));
      f.observe('ordinary ' + method + ' ' + short, { status: response.status, rpc: seen });
      assert.equal(response.status, 200);
      assert.deepEqual(seen, expected);
      assert.equal(f.calls.includes('provider.fetch'), false);
      assert.equal(f.callbacks.length, 0);
      if (short === 'internal/integrations/openclaw/leave') assert.equal((await response.json()).code, 'needs_input');
      if (short === 'admin/confirmed-test-purge') assert.deepEqual(f.calls, ['purge']);
      if (short === 'internal/payroll/session-proof') assert.deepEqual(f.calls, ['proof']);
    } finally { f.cleanup(); }
  });
}

test('ordinary recovery preserves unknown job rejection before any effect', async () => {
  const f = fixture({ uat: false });
  try {
    const path = 'src/app/api/cron/recovery/route.ts';
    const { GET } = await f.load(path);
    const request = apiRequest(path, 'GET');
    const url = new URL(request.url);
    url.searchParams.set('job', 'future-unknown-job');
    const response = await GET(new Request(url, { headers: request.headers }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'unknown_job');
    f.assertZero('ordinary unknown recovery');
  } finally { f.cleanup(); }
});
