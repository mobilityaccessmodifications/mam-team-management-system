import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { executeGraph } from './performance-review-n8n-runner.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HUB = 'https://mam-team-management-system-ten.vercel.app';
const RECEIPTS = HUB + '/api/internal/integrations/notifications/receipts';
const HEADER = {id: 'tGtpwegru8OxtdCt', name: 'MAM Team Management - Notification Webhook Header'};
const OUTLOOK = {id: 'Ug5bTBjvF1vCSdhQ', name: 'Microsoft Outlook - ai@mobilityaccess.com.au'};
const CRON = {id: 'Fa0hGUfG9sTqnZXP', name: 'MAM People System - Check-In Reminder Cron Bearer v2'};
const TOKEN = '720f0200-0000-4000-8000-000000000003';
const PROVIDER = {accepted: true, messageId: null, requestId: null, statusCode: 202};
function build() {
  const result = spawnSync('/usr/bin/python3', ['-B', ROOT + 'scripts/build-performance-review-notifications-workflow.py'], {
    cwd: ROOT, env: {PATH: '/usr/bin:/bin'}, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function payload(event = 'started') {
  const reviewId = '720f0200-0000-4000-8000-000000000001';
  return {version: 1, event, eventKey: `performance-review:${reviewId}:${event}`, reviewId,
    reviewCode: 'PR-2026-900001', cycle: '2026', dueDate: '2026-11-30',
    recipient: event === 'started' ? 'synthetic-employee@example.invalid' : 'synthetic-manager@example.invalid',
    employeeName: 'Synthetic <Employee>', managerName: 'Synthetic & Manager',
    claimToken: '720f0200-0000-4000-8000-000000000002'};
}
const sendGrant = p => ({outcome: 'send', eventKey: p?.eventKey, deliveryToken: TOKEN});
const receipt = (p, duplicate = false) => ({...(duplicate ? {outcome: 'duplicate'} : {}),
  ok: true, sent: !duplicate, alreadySent: duplicate, eventKey: p?.eventKey,
  actualRecipient: p?.recipient, actualCcRecipients: '', providerReceipt: {...PROVIDER}});
const returned = (p, duplicate = false) => receipt(p, duplicate);
const held = {ok: false, sent: false, alreadySent: false};
function harness(workflow, p, {reserve = {statusCode: 200, body: sendGrant(p)},
  provider = {statusCode: 202, body: ''}, confirm = {statusCode: 200, body: receipt(p)}} = {}) {
  const calls = [];
  return {calls, run: () => executeGraph(workflow, 'Receive Performance Notification', {body: p}, async (node, body) => {
    calls.push({name: node.name, body});
    const response = node.name === 'Reserve Notification Delivery' ? reserve
      : node.name === 'Send Performance Notification' ? provider : confirm;
    if (response === null) throw Error('synthetic timeout');
    return response;
  })};
}

test('notification graph binds exact credential references, closed paths and private execution settings', () => {
  const workflow = build();
  assert.equal(workflow.name, 'MAM People Hub - Performance Review Notifications (Live)');
  assert.equal(Object.hasOwn(workflow, 'active'), false);
  assert.equal(workflow.nodes.length, 18);
  assert.deepEqual(workflow.settings, {executionOrder: 'v1', timezone: 'Australia/Melbourne',
    saveDataSuccessExecution: 'none', saveDataErrorExecution: 'none', saveManualExecutions: false,
    saveExecutionProgress: false, executionTimeout: 30});
  const versions = {webhook: 2.1, code: 2, if: 2.2, httpRequest: 4.2, scheduleTrigger: 1.2};
  assert.equal(new Set(workflow.nodes.map(n => n.id)).size, workflow.nodes.length);
  for (const node of workflow.nodes) {
    assert.equal(node.retryOnFail, false, node.name);
    assert.equal(node.typeVersion, versions[node.type.replace('n8n-nodes-base.', '')], node.name);
    if (node.type === 'n8n-nodes-base.code') assert.doesNotMatch(node.parameters.jsCode, /\brequire\s*\(|\bfetch\s*\(|\$getWorkflowStaticData/);
    if (node.type === 'n8n-nodes-base.webhook') {
      assert.equal(node.parameters.authentication, 'headerAuth');
      assert.equal(node.parameters.responseMode, 'lastNode');
      assert.deepEqual(node.credentials.httpHeaderAuth, HEADER);
    }
    if (node.type === 'n8n-nodes-base.httpRequest') {
      assert.equal(node.onError, 'continueRegularOutput');
      assert.equal(node.parameters.options.redirect.redirect.followRedirects, false);
      assert.equal(node.parameters.options.response.response.fullResponse, true);
      assert.equal(node.parameters.options.response.response.neverError, true);
      assert.ok(node.parameters.options.timeout > 0 && node.parameters.options.timeout <= 25000);
      if (node.name === 'Send Performance Notification') {
        assert.equal(node.parameters.authentication, 'predefinedCredentialType');
        assert.equal(node.parameters.nodeCredentialType, 'microsoftOutlookOAuth2Api');
        assert.deepEqual(node.credentials.microsoftOutlookOAuth2Api, OUTLOOK);
        assert.equal(node.parameters.url, 'https://graph.microsoft.com/v1.0/me/sendMail');
        assert.equal(node.parameters.options.response.response.responseFormat, 'text');
        assert.equal(node.parameters.options.response.response.outputPropertyName, 'body');
      } else {
        assert.deepEqual(node.credentials.httpHeaderAuth, node.name === 'Dispatch Performance Notifications' ? CRON : HEADER);
        assert.equal(node.parameters.options.response.response.responseFormat, 'json');
        if (['Reserve Notification Delivery', 'Confirm Notification Delivery'].includes(node.name)) {
          assert.equal(node.parameters.url, RECEIPTS); assert.equal(node.parameters.method, 'POST');
          assert.equal(node.parameters.sendBody, true); assert.equal(node.parameters.contentType, 'json');
        }
      }
    }
  }
});

test('both future events execute reserve, one fixed text email, confirm and exact closed response', async () => {
  for (const event of ['started', 'self-submitted']) {
    const workflow = build(), p = payload(event), h = harness(workflow, p);
    const result = await h.run();
    assert.deepEqual(h.calls.map(c => c.name), ['Reserve Notification Delivery', 'Send Performance Notification', 'Confirm Notification Delivery']);
    assert.deepEqual(h.calls[0].body, {action: 'reserve', eventKey: p.eventKey, recipient: p.recipient,
      cc: '', legacyEventKey: null, claimToken: p.claimToken});
    const mail = h.calls[1].body;
    assert.deepEqual(Object.keys(mail).sort(), ['message', 'saveToSentItems']);
    assert.equal(mail.saveToSentItems, true);
    assert.deepEqual(Object.keys(mail.message).sort(), ['bccRecipients', 'body', 'ccRecipients', 'subject', 'toRecipients']);
    assert.deepEqual(mail.message.toRecipients, [{emailAddress: {address: p.recipient}}]);
    assert.deepEqual(mail.message.ccRecipients, []); assert.deepEqual(mail.message.bccRecipients, []);
    assert.equal(mail.message.body.contentType, 'Text');
    assert.ok(mail.message.body.content.includes(HUB + '/?view=people&tab=performance'));
    assert.ok(mail.message.body.content.includes(p.reviewCode));
    assert.ok(mail.message.body.content.includes(p.employeeName));
    assert.ok(mail.message.body.content.includes(event === 'started' ? p.dueDate : 'arrange the review meeting'));
    assert.deepEqual(h.calls[2].body, {action: 'confirm', eventKey: p.eventKey, recipient: p.recipient,
      cc: '', deliveryToken: TOKEN, providerReceipt: PROVIDER});
    assert.deepEqual(result.value, returned(p));
  }
});

test('closed payload rejects private fields, malformed identifiers, recipient lists and invalid dates before reserve', async () => {
  const workflow = build();
  const mutations = [
    p => {p.managerNote = 'PRIVATE-SYNTHETIC-NOTE';}, p => {p.selfAnswers = ['PRIVATE'];},
    p => {p.meeting = {};}, p => {p.attachment = {};}, p => {p.extra = true;},
    p => {p.version = '1';}, p => {p.event = 'finalised';}, p => {p.eventKey += ':other';},
    p => {p.eventKey = p.eventKey.replace('started', 'self-submitted');}, p => {p.reviewId = 'bad';},
    p => {p.claimToken = 'bad';}, p => {p.reviewCode = 'PR-2026-0';}, p => {p.reviewCode = 'PR-2025-1';},
    p => {p.cycle = 2026;}, p => {p.dueDate = '2026-02-30';}, p => {p.dueDate = '2026-1-01';},
    p => {p.recipient = 'A@example.invalid';}, p => {p.recipient += ',other@example.invalid';},
    p => {p.recipient += ';other@example.invalid';}, p => {p.recipient = ' ' + p.recipient;},
    p => {p.recipient = 'x'.repeat(255) + '@example.invalid';}, p => {p.recipient = 'bad\r\n@example.invalid';},
    p => {p.employeeName = '';}, p => {p.managerName = 'x'.repeat(241);},
    p => {p.employeeName = '\ud800';}, p => {p.managerName = 'Synthetic\r\nBcc: other@example.invalid';},
    p => {delete p.dueDate;}, p => {p[Symbol('extra')] = true;},
    p => {Object.defineProperty(p, 'employeeName', {get() {throw Error('Getter must not run');}, enumerable: true});},
  ];
  for (const mutate of mutations) {
    const p = payload(); mutate(p); const h = harness(workflow, p);
    assert.deepEqual((await h.run()).value, held); assert.equal(h.calls.length, 0);
  }
  for (const p of [null, [], true, 'payload']) {
    const h = harness(workflow, p); assert.deepEqual((await h.run()).value, held); assert.equal(h.calls.length, 0);
  }
  const node = workflow.nodes.find(n => n.name === 'Validate Notification Payload');
  const run = new Function('$json', '$input', 'require', node.parameters.jsCode);
  assert.equal(run({body: payload()}, {all: () => [{json: {}}, {json: {}}]}, () => {throw Error('Builtin disabled');})[0].json.valid, false);
  assert.equal(run({body: payload()}, {all: () => [{json: {}}]}, () => {throw Error('Builtin disabled');})[0].json.valid, true);
});

test('only the exact source-bound grant authorizes sending; wrong business recipient and uncertain reserve stop', async () => {
  const workflow = build(), p = payload();
  const bad = [
    null, {statusCode: 307, body: sendGrant(p)}, {statusCode: 500, body: sendGrant(p)},
    {statusCode: 200, body: {...sendGrant(p), extra: true}},
    {statusCode: 200, body: {...sendGrant(p), eventKey: p.eventKey + ':other'}},
    {statusCode: 200, body: {...sendGrant(p), deliveryToken: 'bad'}},
    {statusCode: 200, body: {outcome: 'send', eventKey: p.eventKey, deliveryToken: TOKEN, recipient: p.recipient}},
    {statusCode: 200, body: {outcome: 'rejected', ok: false}},
  ];
  for (const reserve of bad) {
    const h = harness(workflow, p, {reserve}); assert.deepEqual((await h.run()).value, held);
    assert.deepEqual(h.calls.map(c => c.name), ['Reserve Notification Delivery']);
  }
  const wrong = {...p, recipient: 'different-employee@example.invalid'};
  const result = await executeGraph(workflow, 'Receive Performance Notification', {body: wrong}, async (n, body) => {
    assert.equal(n.name, 'Reserve Notification Delivery'); assert.notEqual(body.recipient, p.recipient);
    return {statusCode: 200, body: {outcome: 'rejected', ok: false, sent: false, alreadySent: false,
      eventKey: p.eventKey, rejectionCode: 'performance-review-unavailable', reconciliationRequired: false}};
  });
  assert.deepEqual(result.value, held); assert.equal(result.entered.includes('Send Performance Notification'), false);
});

test('durable duplicates return only exact matching evidence and never send or confirm again', async () => {
  const workflow = build(), p = payload();
  const valid = receipt(p, true);
  const mutations = [
    b => {b.actualRecipient = 'other@example.invalid';}, b => {b.actualCcRecipients = p.recipient;},
    b => {b.eventKey += ':other';}, b => {b.extra = true;}, b => {b.sent = true;},
    b => {b.alreadySent = 'true';}, b => {b.providerReceipt.accepted = 'true';},
    b => {b.providerReceipt.statusCode = 200;}, b => {b.providerReceipt.messageId = 'invented';},
    b => {b.providerReceipt.extra = true;}, b => {delete b.providerReceipt;},
  ];
  for (const mutate of [null, ...mutations]) {
    const body = structuredClone(valid); mutate?.(body);
    const h = harness(workflow, p, {reserve: {statusCode: 200, body}});
    const result = await h.run();
    const expected = structuredClone(valid); delete expected.outcome;
    assert.deepEqual(result.value, mutate ? held : expected);
    assert.deepEqual(h.calls.map(c => c.name), ['Reserve Notification Delivery']);
  }
});

test('only empty Graph 202 reaches confirm; transport, redirects, nonempty and rejected responses never retry', async () => {
  const workflow = build(), p = payload();
  for (const provider of [null, {statusCode: 202}, {statusCode: '202', body: ''},
    {statusCode: 202, body: null}, {statusCode: 202, body: {}}, {statusCode: 202, body: ' '},
    {statusCode: 202, body: '{"id":"synthetic"}'}, {statusCode: 200, body: ''},
    {statusCode: 307, body: ''}, {statusCode: 400, body: ''}, {statusCode: 429, body: ''}, {statusCode: 503, body: ''}]) {
    const h = harness(workflow, p, {provider}); assert.deepEqual((await h.run()).value, held);
    assert.deepEqual(h.calls.map(c => c.name), ['Reserve Notification Delivery', 'Send Performance Notification']);
  }
});

test('confirm success requires exact recipient, event, provider evidence and boolean acknowledgement', async () => {
  const workflow = build(), p = payload();
  const mutations = [
    b => {b.ok = 'true';}, b => {b.sent = false;}, b => {b.alreadySent = true;},
    b => {b.eventKey += ':other';}, b => {b.actualRecipient = 'other@example.invalid';},
    b => {b.actualCcRecipients = p.recipient;}, b => {b.providerReceipt.statusCode = 200;},
    b => {b.providerReceipt.requestId = 'invented';}, b => {b.providerReceipt.extra = true;},
    b => {b.outcome = 'duplicate';}, b => {b.managerNote = 'PRIVATE';},
  ];
  for (const mutate of mutations) {
    const body = receipt(p); mutate(body); const h = harness(workflow, p, {confirm: {statusCode: 200, body}});
    assert.deepEqual((await h.run()).value, held); assert.equal(h.calls.filter(c => c.name === 'Send Performance Notification').length, 1);
  }
  for (const confirm of [null, {statusCode: 307, body: receipt(p)}, {statusCode: 503, body: receipt(p)}]) {
    const h = harness(workflow, p, {confirm}); assert.deepEqual((await h.run()).value, held);
    assert.equal(h.calls.length, 3);
  }
});

test('concurrent reservations and late retries cannot dispatch a second provider request', async () => {
  const workflow = build(), p = payload(); let state = 'new', sends = 0;
  const http = async node => {
    if (node.name === 'Reserve Notification Delivery') {
      if (state === 'new') {state = 'processing'; return {statusCode: 200, body: sendGrant(p)};}
      return {statusCode: 200, body: state === 'sent' ? receipt(p, true) : {outcome: 'rejected', ok: false}};
    }
    if (node.name === 'Send Performance Notification') {sends++; return {statusCode: 202, body: ''};}
    assert.equal(node.name, 'Confirm Notification Delivery'); state = 'sent'; return {statusCode: 200, body: receipt(p)};
  };
  const results = await Promise.all([1, 2].map(() => executeGraph(workflow, 'Receive Performance Notification', {body: p}, http)));
  assert.equal(sends, 1); assert.equal(results.filter(r => r.value.sent).length, 1);
  const late = await executeGraph(workflow, 'Receive Performance Notification', {body: p}, http);
  assert.equal(late.value.alreadySent, true); assert.equal(sends, 1);
});

test('an unknown provider outcome leaves the durable reservation blocking any later send', async () => {
  const workflow = build(), p = payload(); let reserved = false, sends = 0;
  const http = async node => {
    if (node.name === 'Reserve Notification Delivery') {
      if (!reserved) {reserved = true; return {statusCode: 200, body: sendGrant(p)};}
      return {statusCode: 200, body: {outcome: 'rejected', ok: false, sent: false, alreadySent: false,
        eventKey: p.eventKey, rejectionCode: 'receipt-delivery-unknown', reconciliationRequired: true}};
    }
    assert.equal(node.name, 'Send Performance Notification'); sends++; throw Error('synthetic timeout');
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await executeGraph(workflow, 'Receive Performance Notification', {body: p}, http);
    assert.deepEqual(result.value, held); assert.equal(result.entered.includes('Confirm Notification Delivery'), false);
  }
  assert.equal(sends, 1);
});

test('authenticated readiness GET proves only the receipt store and is disjoint from reserve, send and cron', async () => {
  const workflow = build(), ready = workflow.nodes.find(n => n.name === 'Receive Notification Readiness');
  assert.equal(ready.parameters.httpMethod, 'GET');
  assert.equal(ready.parameters.path, 'mam-people-hub-performance-review-notifications-v1-ready');
  for (const response of [{statusCode: 200, body: {version: 1, ready: true}},
    {statusCode: 200, body: {version: '1', ready: true}}, {statusCode: 200, body: {version: 1, ready: 'true'}},
    {statusCode: 200, body: {version: 1, ready: true, extra: true}}, {statusCode: 500, body: {version: 1, ready: true}}, null]) {
    const calls = [];
    const result = await executeGraph(workflow, 'Receive Notification Readiness', {}, async (node, body) => {
      calls.push(node.name); assert.equal(node.parameters.method, 'GET'); assert.equal(node.parameters.url, RECEIPTS);
      assert.equal(body, undefined); if (response === null) throw Error('timeout'); return response;
    });
    const ok = response?.statusCode === 200 && response.body.version === 1 && response.body.ready === true && Object.keys(response.body).length === 2;
    assert.deepEqual(result.value, {ok, ready: ok}); assert.deepEqual(calls, ['Check Notification Receipt Readiness']);
    assert.equal(result.entered.includes('Send Performance Notification'), false);
  }
});

test('one five minute schedule dispatches only notifications=1 with cron auth and bounded timeout', async () => {
  const workflow = build(), schedule = workflow.nodes.find(n => n.name === 'Every Five Minutes');
  assert.deepEqual(schedule.parameters.rule, {interval: [{field: 'minutes', minutesInterval: 5}]});
  const receive = workflow.nodes.find(n => n.name === 'Receive Performance Notification');
  assert.equal(receive.parameters.httpMethod, 'POST'); assert.equal(receive.parameters.path, 'mam-people-hub-performance-review-notifications-v1');
  const calls = [];
  const result = await executeGraph(workflow, 'Every Five Minutes', {}, async (node, body) => {
    calls.push(node.name); assert.equal(node.parameters.method, 'GET');
    assert.equal(node.parameters.url, HUB + '/api/performance-reviews/mail?notifications=1');
    assert.equal(node.parameters.options.timeout, 25000); assert.equal(body, undefined);
    return {statusCode: 200, body: {ok: true}};
  });
  assert.deepEqual(calls, ['Dispatch Performance Notifications']); assert.equal(result.entered.includes('Send Performance Notification'), false);
});
