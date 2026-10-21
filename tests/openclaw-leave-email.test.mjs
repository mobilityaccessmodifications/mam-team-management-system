import {Receiver,canonical} from './notification-workflow-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const id = '10000000-0000-4000-8000-000000000001';
const otherId = '10000000-0000-4000-8000-000000000002';
const submitted = { status: 200, body: { code: 'submitted', requestId: id, status: 'Pending' } };
const routePath = 'src/app/api/internal/integrations/openclaw/leave/route.ts';
const environment = {
  MAM_OPENCLAW_LEAVE_ENABLED: 'true',
  MAM_OPENCLAW_LEAVE_BRIDGE_SECRET: 's'.repeat(43),
  MAM_OPENCLAW_LEAVE_ACCOUNT: 'synthetic',
  MAM_N8N_LEAVE_WEBHOOK_URL: 'https://example.test/hook',
  MAM_N8N_LEAVE_WEBHOOK_ORIGIN: 'https://example.test',
  MAM_N8N_LEAVE_WEBHOOK_SECRET: 'synthetic-only',
};

// No live environment, client or fetch can enter these route/dispatcher tests.
function load(file, imports, { fetch = () => assert.fail('Unexpected network'), warnings = [] } = {}) {
  const mod = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', 'process', 'console', 'fetch', code)(
    key => { assert(key in imports, `Unexpected import ${key}`); return imports[key]; },
    mod, mod.exports, { env: { ...environment } }, { warn: (...args) => warnings.push(args) }, fetch,
  );
  return mod.exports;
}

function request() {
  return new Request('https://example.test/api/internal/integrations/openclaw/leave', {
    method: 'POST', headers: { 'content-type': 'application/json',
      'x-mam-timestamp': String(Date.now()), 'x-mam-signature': '0'.repeat(64) },
    body: JSON.stringify({ requestId: otherId, recipients: ['untrusted@example.test'] }),
  });
}

function route({ result = submitted, dispatch = async () => {}, schedule } = {}) {
  const jobs = [], calls = [], warnings = [];
  const mod = load(routePath, {
    'next/server': { after: schedule ?? (fn => jobs.push(fn)) },
    '@/lib/openclaw-leave-contract': {
      LEAVE_BRIDGE_PATH: '/api/internal/integrations/openclaw/leave',
      handleLeaveBridge: async () => result,
    },
    '@/lib/openclaw-leave-store': { createLeaveBridgeStore: () => ({}) },
    '@/lib/leave-notification-outbox': {
      dispatchLeaveNotificationsForRequest: async requestId => { calls.push(requestId); await dispatch(requestId); },
    },
  }, { warnings });
  return { ...mod, jobs, calls, warnings };
}

test('committed confirmation schedules the portal dispatcher without delaying the response', async () => {
  const h = route();
  const response = await h.POST(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), submitted.body);
  assert.deepEqual(h.calls, []);
  assert.equal(h.jobs.length, 1);
  assert.equal(h.maxDuration, 60);
  await h.jobs[0]();
  assert.deepEqual(h.calls, [id]); // Never the ID/recipients in caller input.
});

test('preparation, rejection and malformed success cannot schedule or drain any mail', async () => {
  const cases = [
    { status: 200, body: { code: 'prepared', requestId: id, status: 'Pending' } },
    { status: 200, body: { code: 'needs_input' } },
    { status: 401, body: { code: 'unauthorized' } },
    { status: 409, body: { code: 'restart_required' } },
    { status: 409, body: { code: 'conflict' } },
    { status: 503, body: { code: 'submitted', requestId: id, status: 'Pending' } },
    { status: 200, body: { code: 'submitted', status: 'Pending' } },
    { status: 200, body: { code: 'submitted', requestId: null, status: 'Pending' } },
    { status: 200, body: { code: 'submitted', requestId: '', status: 'Pending' } },
    { status: 200, body: { code: 'submitted', requestId: 'not-an-id', status: 'Pending' } },
    { status: 200, body: { code: 'submitted', requestId: id, status: 'Approved' } },
  ];
  for (const result of cases) {
    const h = route({ result });
    assert.equal((await h.POST(request())).status, result.status);
    assert.deepEqual(h.jobs, []);
    assert.deepEqual(h.calls, []);
  }
});

test('failure to schedule notifications never reports an already committed leave as failed', async () => {
  const h = route({ schedule: () => { throw new Error('synthetic scheduling failure'); } });
  const response = await h.POST(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), submitted.body);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.warnings, [['Leave notification remains queued.']]);
});

function outbox({ failFirst = false, claimFails = false } = {}) {
  const warnings = [], claims = [], keys = [], deliveries = [];
  let delivered = false, networkFailure = failFirst;
  const receiver = new Receiver();
  const row = { delivery_id: id, claim_token: id, payload: {
    version: 1, event: 'leave-submitted', requestId: id, employeeName: 'Synthetic Employee',
    company: 'mam', leaveType: 'Unpaid leave', startDate: '2026-10-01', endDate: '2026-10-01',
    startTime: null, endTime: null, days: 1, hours: null, status: 'Pending',
    employeeNote: null, managerNote: null,
    employeeEmail: 'employee@example.test', employeeEmails: ['employee@example.test'], managerEmail: 'manager@example.test',
  } };
  const dispatcher = load('src/lib/leave-notification-outbox.ts', {
    'server-only': {}, 'node:crypto': require('node:crypto'),
    '@/lib/supabase/admin': { createAdminClient: () => ({ rpc: async (name, args) => {
      if (name === 'claim_leave_notification_outbox') {
        assert.deepEqual(args, { p_request_id: id, p_limit: 1 });
        claims.push(args);
        if (claimFails) throw new Error('synthetic database failure');
        return { data: delivered ? [] : [row], error: null };
      }
      assert.equal(name, 'finish_leave_notification_outbox');
      assert.equal(args.p_delivery_id, id);
      assert.equal(args.p_claim_token, id);
      delivered = args.p_delivered;
      return { data: true, error: null };
    } }) },
  }, { warnings, fetch: async (url, options) => {
    assert.equal(String(url), 'https://example.test/hook');
    const body = JSON.parse(options.body);
    assert.equal(body.requestId, id);
    assert.equal(body.leaveBalance, undefined);
    keys.push(body.eventKey);
    if (networkFailure) { networkFailure = false; throw new Error('synthetic timeout'); }
    // Execute the exact graph emitted by the deploy helper, with synthetic I/O.
    const receipt = receiver.run(body);
    const expected = body.audience === 'employee' ? 'employee@example.test' : 'manager@example.test,career@mobilityaccess.com.au';
    assert.equal(receipt.actualRecipient, canonical(expected));
    assert.equal(receipt.ok,true);
    if(receipt.sent) {
      const output=receiver.sends.at(-1);
      assert.equal(output.ccRecipients, '');
      deliveries.push(output);
    }
    return Response.json(receipt);
  } });
  return { dispatch: dispatcher.dispatchLeaveNotificationsForRequest, warnings, claims, keys, deliveries,
    delivered: () => delivered };
}

test('confirmed route and successful replay use the existing queue once and preserve employee/manager/HR recipients', async () => {
  const q = outbox(), h = route({ dispatch: q.dispatch });
  for (let i = 0; i < 2; i++) {
    const response = await h.POST(request());
    assert.deepEqual(await response.json(), submitted.body);
    await h.jobs.shift()();
  }
  assert.equal(q.claims.length, 2);
  assert.equal(q.delivered(), true);
  assert.equal(q.deliveries.length, 2);
  assert.equal(q.keys.length, 2);
  assert.deepEqual(q.warnings, []);
});

test('mail failure stays retryable without changing submission; replay reuses the stable delivery key', async () => {
  const q = outbox({ failFirst: true }), h = route({ dispatch: q.dispatch });
  assert.deepEqual(await (await h.POST(request())).json(), submitted.body);
  await h.jobs.shift()();
  assert.equal(q.delivered(), false);
  assert.equal(q.deliveries.length, 1);
  assert.equal(q.warnings.length, 1);
  assert.deepEqual(await (await h.POST(request())).json(), submitted.body);
  await h.jobs.shift()(); // Synthetic claim represents the due queue retry.
  assert.equal(q.delivered(), true);
  assert.equal(q.deliveries.length, 2);
  assert.equal(q.keys.length, 4);
  assert.equal(new Set(q.keys).size, 2);
});

test('notification claim failure does not turn successful confirmation into unavailable', async () => {
  const q = outbox({ claimFails: true }), h = route({ dispatch: q.dispatch });
  const response = await h.POST(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), submitted.body);
  await h.jobs.shift()();
  assert.equal(q.keys.length, 0);
  assert.deepEqual(q.warnings, [['Leave notification remains queued.']]);
});
