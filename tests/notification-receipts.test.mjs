import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Evaluate the actual n8n node sources. All clocks, static state, send results
// and payloads are synthetic; this harness has no provider or database access.
const code = name => readFileSync(`workflows/leave-notification-${name}.n8n.txt`, 'utf8');
const validate = new Function('$input', '$getWorkflowStaticData', 'Date', code('validator'));
const confirm = new Function('$', '$input', '$getWorkflowStaticData', 'Date', code('confirmation'));
const duplicate = new Function('$json', code('duplicate'));
const rejection = new Function('$json', code('rejection'));
const now = Date.UTC(2026, 8, 22, 10);
const TTL = 90 * 24 * 60 * 60 * 1000;
const processing = 20 * 60 * 1000;
const id = '10000000-0000-4000-8000-000000000001';
const base = { version: 1, requestId: id, employeeName: 'Synthetic Employee', employeeEmail: 'employee@example.test',
  company: 'mam', leaveType: 'Annual leave', startDate: '2026-10-01', endDate: '2026-10-02',
  startTime: null, endTime: null, days: 2, hours: null, status: 'Pending',
  employeeNote: null, managerNote: null, managerEmail: 'manager@example.test' };
const branches = [
  ...['leave-submitted', 'leave-approved', 'leave-declined', 'leave-cancelled', 'leave-conditionally-approved',
    'leave-reminder', 'team-birthday'].map(event => ({ ...base, event,
    eventKey: `leave:${id}:${event}:${'a'.repeat(24)}`, ...(event === 'leave-submitted' ? { audience: 'reviewers' } : {}) })),
  { ...base, event: 'leave-submitted', audience: 'employee', eventKey: `leave:${id}:leave-submitted:${'b'.repeat(24)}` },
  { version: 1, event: 'payroll-balance-reminder', requestId: id, recipientName: 'Synthetic Payroll',
    recipientEmail: 'payroll@example.test', reminderMonth: '2026-10-01', missingCompanies: ['mam', 'equipsy'],
    eventKey: `payroll-balance:${id}:2026-10` },
  { version: 1, event: 'payroll-comparison-alert', batchId: id, differenceCount: 2, eventKey: `payroll-comparison:${id}` },
];
function harness(state = {}) {
  let time = now;
  class Clock extends Date { static now() { return time; } }
  return {
    state,
    setTime: value => { time = value; },
    run: body => validate({ first: () => ({ json: { headers: { 'content-type': 'application/json' }, body } }) }, () => state, Clock)[0].json,
    confirm: (source, provider = { statusCode: 202, id: 'synthetic-provider-id', headers: { 'request-id': 'synthetic-provider-request' } }) =>
      confirm(() => ({ all: () => [{ json: source }] }), { all: () => [{ json: provider }] }, () => state, Clock)[0].json,
  };
}
function sentReceipt(at = now, actualRecipient = 'original@example.test', actualCcRecipients = '') {
  return { state: 'sent', at, actualRecipient, actualCcRecipients,
    providerReceipt: { accepted: true, messageId: 'synthetic-original', requestId: null, statusCode: 202 } };
}
function history(count) {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`history:${i}`, sentReceipt(now - i)]));
}
function assertReconciliation(result, code) {
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  assert.equal(result.alreadySent, false);
  assert.equal(result.reconciliationRequired, true);
  assert.equal(result.rejectionCode, code);
}

for (const body of branches) {
  const label = `${body.event}${body.audience ? `/${body.audience}` : ''}`;
  test(`${label}: successful receipt replays the original normalized To/CC and provider evidence`, () => {
    const h = harness();
    const send = h.run(body);
    assert.equal(send.outcome, 'send');
    const accepted = h.confirm(send, { statusCode: 202, id: 'original-message-id', headers: { 'request-id': 'original-request-id' },
      body: { employeeNote: 'Synthetic confidential note', emailHtml: '<p>private</p>' }, ignoredToken: 'synthetic-secret' });
    h.run(branches.find(other => other.eventKey !== body.eventKey)); // Exercise pruning before the replay.
    const replay = h.run(body);
    assert.equal(replay.outcome, 'duplicate');
    assert.equal(replay.actualRecipient, accepted.actualRecipient);
    assert.equal(replay.actualCcRecipients, accepted.actualCcRecipients);
    assert.deepEqual(replay.providerReceipt, accepted.providerReceipt);
    assert.deepEqual(duplicate(replay)[0].json, { ...accepted, sent: false, alreadySent: true });
    assert.deepEqual(Object.keys(h.state.leaveNotificationEvents[body.eventKey]).sort(),
      ['state', 'at', 'actualRecipient', 'actualCcRecipients', 'providerReceipt'].sort());
    const serialized = JSON.stringify(h.state);
    for (const privateValue of ['Synthetic confidential note', '<p>private</p>', 'synthetic-secret']) assert(!serialized.includes(privateValue));
  });
  test(`${label}: changed To and changed CC require reconciliation without a second send`, () => {
    for (const field of ['actualRecipient', 'actualCcRecipients']) {
      const h = harness();
      const send = h.run(body);
      // Model an original send under the prior recipient configuration, then
      // evaluate today's payload against that genuine confirmation-node receipt.
      const sourceField = field === 'actualRecipient' ? 'deliveryRecipient' : 'ccRecipients';
      send[sourceField] = 'prior@example.test';
      h.state.leaveNotificationEvents[body.eventKey][sourceField] = 'prior@example.test';
      const original = h.confirm(send);
      const before = structuredClone(h.state.leaveNotificationEvents[body.eventKey]);
      const replay = h.run(body);
      assertReconciliation(replay, 'receipt-recipient-mismatch');
      assert.equal(replay[field], original[field]);
      assert.deepEqual(replay.providerReceipt, original.providerReceipt);
      assert.deepEqual(h.state.leaveNotificationEvents[body.eventKey], before);
      assert.throws(() => duplicate(replay), /reconciliation required/);
    }
  });
  test(`${label}: legacy evidence cannot acknowledge today's addresses or automatically resend`, () => {
    for (const receipt of [
      { state: 'sent', at: now },
      { state: 'sent', at: now - TTL - 1 },
      { ...sentReceipt(), actualRecipient: undefined },
      { ...sentReceipt(), actualCcRecipients: undefined },
      { ...sentReceipt(), providerReceipt: undefined },
    ]) {
      const h = harness({ leaveNotificationEvents: { [body.eventKey]: receipt } });
      assertReconciliation(h.run(body), 'receipt-evidence-unavailable');
      assert.equal(Object.keys(h.state.leaveNotificationEvents).length, 1);
      if (!receipt.actualRecipient) assert.equal(h.run(body).actualRecipient, undefined);
    }
  });
  test(`${label}: 4999 -> 5000 admits one send; 5001 fails visibly and preserves the latest receipt`, () => {
    const h = harness({ leaveNotificationEvents: history(4999) });
    const send = h.run(body);
    assert.equal(send.outcome, 'send');
    assert.equal(Object.keys(h.state.leaveNotificationEvents).length, 5000);
    assert.equal(h.run(body).rejectionCode, 'delivery-in-flight');
    h.confirm(send);
    assert.equal(h.run(body).outcome, 'duplicate');
    const another = branches.find(other => other.eventKey !== body.eventKey);
    assert.throws(() => h.run(another), /receipt capacity reached; reconciliation required/);
    assert.equal(Object.keys(h.state.leaveNotificationEvents).length, 5000);
    assert.equal(h.run(body).outcome, 'duplicate');
    // An old validator may already have exceeded the cap. Preserve all entries,
    // especially the last inserted receipt which the former trim discarded.
    h.state.leaveNotificationEvents = { ...history(5000), [body.eventKey]: h.state.leaveNotificationEvents[body.eventKey] };
    assert.equal(Object.keys(h.state.leaveNotificationEvents).length, 5001);
    assert.equal(h.run(body).outcome, 'duplicate');
    assert.throws(() => h.run(another), /receipt capacity reached/);
    assert.equal(Object.keys(h.state.leaveNotificationEvents).length, 5001);
    h.state.leaveNotificationEvents[body.eventKey] = { state: 'processing', at: now };
    assert.equal(h.run(body).rejectionCode, 'delivery-in-flight');
    assert.equal(Object.keys(h.state.leaveNotificationEvents).length, 5001);
  });
  test(`${label}: TTL never permits replay or discards current/in-flight keys`, () => {
    const h = harness();
    h.confirm(h.run(body));
    const original = structuredClone(h.state.leaveNotificationEvents[body.eventKey]);
    h.setTime(now + TTL);
    h.run(branches.find(other => other.eventKey !== body.eventKey));
    assert.deepEqual(h.state.leaveNotificationEvents[body.eventKey], original);
    h.setTime(now + TTL + 1);
    assert.equal(h.run(body).outcome, 'duplicate'); // Current key is protected even past TTL.
    h.run(branches.find(other => other.eventKey !== body.eventKey));
    assert.deepEqual(h.state.leaveNotificationEvents[body.eventKey], { state: 'sent', at: now, evidenceExpired: true });
    assertReconciliation(h.run(body), 'receipt-evidence-unavailable');
    h.state.leaveNotificationEvents[body.eventKey] = { state: 'processing', at: now };
    h.run(branches.find(other => other.eventKey !== body.eventKey));
    assert.deepEqual(h.state.leaveNotificationEvents[body.eventKey], { state: 'processing', at: now });
    const unresolved = h.run(body);
    assertReconciliation(unresolved, 'receipt-delivery-unknown');
    assert.equal(unresolved.actualRecipient, undefined);
    assert.equal(unresolved.actualCcRecipients, undefined);
    assert.equal(unresolved.providerReceipt, undefined);
  });
  test(`${label}: concurrent retries and ambiguous/provider failures cannot take over a reservation`, () => {
    const h = harness();
    const send = h.run(body);
    assert.equal(h.run(body).rejectionCode, 'delivery-in-flight');
    const reserved = structuredClone(h.state);
    assert.throws(() => h.confirm(send, { statusCode: 500, error: 'synthetic failure' }), /provider explicitly rejected/);
    assert.deepEqual(h.state, reserved);
    h.setTime(now + processing - 1);
    assert.equal(h.run(body).rejectionCode, 'delivery-in-flight');
    h.setTime(now + processing);
    const unresolved = h.run(body);
    assertReconciliation(unresolved, 'receipt-delivery-unknown');
    assert.equal(unresolved.actualRecipient, undefined); // A reservation is not evidence of a send.
    assert.equal(unresolved.providerReceipt, undefined);
    // The original in-flight provider may still complete. Its original
    // reservation survives and can be confirmed without sending again.
    h.confirm(send);
    assert.equal(h.run(body).outcome, 'duplicate');
  });
}

test('actual recipient change on a leave or payroll retry returns the original receipt', () => {
  for (const [body, field] of [[branches[0], 'managerEmail'], [branches[1], 'employeeEmail'], [branches[8], 'recipientEmail']]) {
    const h = harness();
    const original = h.confirm(h.run(body));
    const replay = h.run({ ...body, [field]: 'replacement@example.test' });
    assertReconciliation(replay, 'receipt-recipient-mismatch');
    assert.equal(replay.actualRecipient, original.actualRecipient);
    assert(!replay.actualRecipient.includes('replacement@example.test'));
  }
});

test('recipient comparison normalizes address case, duplicates and ordering without changing original evidence', () => {
  const body = { ...branches[1], employeeEmails: ['Work@Example.Test', 'personal@example.test', 'work@example.test'] };
  const h = harness();
  const accepted = h.confirm(h.run(body));
  assert.equal(accepted.actualRecipient, 'work@example.test,personal@example.test');
  const replay = h.run({ ...body, employeeEmails: ['PERSONAL@example.test', 'work@example.test'] });
  assert.equal(replay.outcome, 'duplicate');
  assert.equal(replay.actualRecipient, accepted.actualRecipient);
});

test('both rollout copies reconcile unknown or differently addressed legacy shared receipts', () => {
  const legacyEventKey = `leave:${id}:leave-submitted:${'c'.repeat(24)}`;
  for (const audience of ['employee', 'reviewers']) {
    for (const receipt of [{ state: 'sent', at: now }, sentReceipt(now - TTL - 1)]) {
      const h = harness({ leaveNotificationEvents: { [legacyEventKey]: receipt } });
      const body = { ...branches[0], audience, legacyEventKey };
      const replay = h.run(body);
      assertReconciliation(replay, receipt.actualRecipient ? 'legacy-receipt-reconciliation' : 'receipt-evidence-unavailable');
      assert.equal(replay.receiptEventKey, legacyEventKey);
      assert.equal(h.state.leaveNotificationEvents[body.eventKey], undefined);
      assert.deepEqual(h.state.leaveNotificationEvents[legacyEventKey], receipt);
    }
  }
});

test('a confirmed current copy takes precedence over an unknown legacy alias', () => {
  const h = harness();
  const body = { ...branches[0], legacyEventKey: `leave:${id}:leave-submitted:${'c'.repeat(24)}` };
  h.confirm(h.run(body));
  h.state.leaveNotificationEvents[body.legacyEventKey] = { state: 'sent', at: now };
  assert.equal(h.run(body).outcome, 'duplicate');
});

test('expired evidence and malformed receipts still consume capacity; no unverified key is dropped', () => {
  const events = history(5000);
  events['history:0'] = sentReceipt(now - TTL - 1);
  events['history:1'] = null;
  events['history:2'] = { state: 'processing', at: now - TTL - 1 };
  const h = harness({ leaveNotificationEvents: events });
  assert.throws(() => h.run(branches[0]), /receipt capacity reached/);
  assert.deepEqual(events['history:0'], { state: 'sent', at: now - TTL - 1, evidenceExpired: true });
  assert.equal(events['history:1'], null);
  assert.equal(events['history:2'].state, 'processing');
  assert.equal(Object.keys(events).length, 5000);
});

test('last capacity slot protects its active reservation while another event attempts a send', () => {
  const h = harness({ leaveNotificationEvents: history(4999) });
  const send = h.run(branches[0]);
  const reservation = structuredClone(h.state.leaveNotificationEvents[send.eventKey]);
  assert.throws(() => h.run(branches[1]), /receipt capacity reached/);
  assert.deepEqual(h.state.leaveNotificationEvents[send.eventKey], reservation);
  h.confirm(send);
  assert.equal(h.run(branches[0]).outcome, 'duplicate');
});

test('confirmation cannot recreate a missing reservation or overwrite original sent evidence', () => {
  const h = harness();
  const send = h.run(branches[0]);
  assert.throws(() => harness().confirm(send), /reservation mismatch/);
  h.confirm(send);
  const original = structuredClone(h.state);
  assert.throws(() => h.confirm(send, { id: 'later-provider-id' }), /reservation mismatch/);
  assert.deepEqual(h.state, original);
});

test('provider nodes without message IDs preserve absence honestly', () => {
  const h = harness();
  const receipt = h.confirm(h.run(branches[0]), { success: true });
  assert.deepEqual(receipt.providerReceipt, { accepted: true, messageId: null, requestId: null, statusCode: null });
  assert.deepEqual(h.run(branches[0]).providerReceipt, receipt.providerReceipt);
});

test('duplicate response node refuses old fallback recipients and success from rejected input', () => {
  assert.throws(() => duplicate({ eventKey: branches[0].eventKey, confirmationRecipient: 'current@example.test' }), /evidence unavailable/);
  assert.throws(() => duplicate({ ...sentReceipt(), outcome: 'rejected', ok: false, alreadySent: true }), /evidence unavailable/);
});

test('rejection response preserves original evidence and reconciliation status without inventing or exposing other data', () => {
  const h = harness();
  const receipt = h.confirm(h.run(branches[1]));
  const mismatch = h.run({ ...branches[1], employeeEmail: 'replacement@example.test' });
  const response = rejection({ ...mismatch, employeeNote: 'synthetic private note', emailHtml: '<p>private</p>' })[0].json;
  assert.equal(response.ok, false);
  assert.equal(response.sent, false);
  assert.equal(response.alreadySent, false);
  assert.equal(response.reconciliationRequired, true);
  assert.equal(response.rejectionCode, 'receipt-recipient-mismatch');
  assert.equal(response.actualRecipient, receipt.actualRecipient);
  assert.deepEqual(response.providerReceipt, receipt.providerReceipt);
  assert.equal(response.employeeNote, undefined);
  assert.equal(response.emailHtml, undefined);
  const legacy = harness({ leaveNotificationEvents: { [branches[1].eventKey]: { state: 'sent', at: now } } });
  const unknown = rejection(legacy.run(branches[1]))[0].json;
  assert.equal(unknown.reconciliationRequired, true);
  assert.equal(unknown.actualRecipient, undefined);
  assert.equal(unknown.providerReceipt, undefined);
  const invalid = rejection({ outcome: 'rejected', rejectionCode: 'body-shape', actualRecipient: 'current@example.test' })[0].json;
  assert.equal(invalid.actualRecipient, undefined);
});

test('lost database acknowledgement plus a recipient change never acknowledges the replacement or sends twice', async () => {
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  const compiled = ts.transpileModule(readFileSync('src/lib/leave-notification-outbox.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const h = harness(), acks = [], responses = [];
  let sends = 0;
  const row = { delivery_id: id, claim_token: id, payload: { ...branches[1], employeeEmails: ['employee@example.test'] } };
  const imports = {
    'server-only': {}, 'node:crypto': require('node:crypto'),
    '@/lib/supabase/admin': { createAdminClient: () => ({ rpc: async (name, args) => {
      if (name === 'claim_leave_notification_outbox') return { data: [row], error: null };
      assert.equal(name, 'finish_leave_notification_outbox');
      acks.push(args.p_delivered);
      return { data: false, error: null }; // Provider succeeded, database acknowledgement was lost.
    } }) },
  };
  const mod = { exports: {} };
  const fetch = async (url, options) => {
    assert.equal(String(url), 'https://example.test/hook');
    const result = h.run(JSON.parse(options.body));
    let receipt = result;
    if (result.outcome === 'send') { sends++; receipt = h.confirm(result); }
    if (result.outcome === 'duplicate') receipt = duplicate(result)[0].json;
    if (result.outcome === 'rejected') receipt = rejection(result)[0].json;
    responses.push(receipt);
    return Response.json(receipt);
  };
  new Function('require', 'module', 'exports', 'process', 'fetch', compiled)(
    name => { assert(name in imports, `Unexpected import ${name}`); return imports[name]; }, mod, mod.exports,
    { env: { MAM_N8N_LEAVE_WEBHOOK_URL: 'https://example.test/hook', MAM_N8N_LEAVE_WEBHOOK_ORIGIN: 'https://example.test',
      MAM_N8N_LEAVE_WEBHOOK_SECRET: 'synthetic-only' } }, fetch,
  );
  const dispatch = mod.exports.dispatchLeaveNotificationOutbox;
  assert.equal((await dispatch()).failed, 1);
  row.payload.employeeEmails = ['replacement@example.test'];
  assert.equal((await dispatch()).failed, 1);
  assert.deepEqual(acks, [true, false]);
  assert.equal(sends, 1);
  assert.equal(responses[1].reconciliationRequired, true);
  assert.equal(responses[1].rejectionCode, 'receipt-recipient-mismatch');
  assert.equal(responses[1].actualRecipient, 'employee@example.test');
});
