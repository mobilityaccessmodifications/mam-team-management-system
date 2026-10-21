import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMailWorkflow } from './helpers/performance-review-http-producer.mjs';
import { payload } from './performance-review-n8n-fixtures.mjs';
import { fixture, loadMailHarness, request, ack, ids } from './helpers/performance-review-mail-harness.mjs';

const source = buildMailWorkflow().nodes.find(node => node.name === 'Validate Payload').parameters.jsCode;
const validateSaved = wire => new Function('$json', '$input', source)({ body: wire }, { all: () => [{ json: { body: wire } }] })[0].json;
const begin = () => ({ phase: 'begin', deliveryId: ids.delivery, claimToken: ids.claim, attachmentSha256: 'a'.repeat(64),
  recipient: 'manager@mobilityaccess.com.au', ccRecipients: ['reviewer-one@mobilityaccess.com.au', 'reviewer-two@mobilityaccess.com.au'] });
const invalidCc = () => [
  undefined, null, {}, 'reviewer-one@mobilityaccess.com.au', [null],
  ['careers@mobilityaccess.com.au'], ['manager@mobilityaccess.com.au'], ['external@example.test'],
  ['Reviewer@mobilityaccess.com.au'], [' reviewer@mobilityaccess.com.au'], ['reviewer@mobilityaccess.com.au\r\nBcc:other@mobilityaccess.com.au'],
  ['reviewer-one@mobilityaccess.com.au', 'reviewer-one@mobilityaccess.com.au'],
  ['reviewer-two@mobilityaccess.com.au', 'reviewer-one@mobilityaccess.com.au'],
  ['one@mobilityaccess.com.au', 'three@mobilityaccess.com.au', 'two@mobilityaccess.com.au'],
];

test('both mail consumers reject omitted, malformed, duplicate and noncanonical CC sets', () => {
  const h = loadMailHarness();
  for (const cc of invalidCc()) {
    const wire = payload();
    if (cc === undefined) delete wire.ccRecipients;
    else wire.ccRecipients = cc;
    assert.throws(() => h.mail.validatePerformanceReviewMailPayload(wire), /Invalid performance review data|invalid_payload/);
    const saved = validateSaved(wire);
    assert.equal(saved.valid, false, JSON.stringify(cc));
    assert.equal(Object.hasOwn(saved, 'graphBody'), false);
    assert.equal(Object.hasOwn(saved, 'beginBody'), false);
  }
});

test('both mail consumers reject sparse, accessor and extended CC arrays without invoking accessors', () => {
  const h = loadMailHarness();
  const sparse = Array(1), accessor = ['reviewer@mobilityaccess.com.au'];
  Object.defineProperty(accessor, '0', { get() { throw Error('CC accessor must not run'); }, enumerable: true });
  const extra = ['reviewer@mobilityaccess.com.au']; extra.other = 'foreign@mobilityaccess.com.au';
  const symbol = ['reviewer@mobilityaccess.com.au']; symbol[Symbol('recipient')] = 'foreign@mobilityaccess.com.au';
  for (const cc of [sparse, accessor, extra, symbol]) {
    const wire = payload(); wire.ccRecipients = cc;
    assert.throws(() => h.mail.validatePerformanceReviewMailPayload(wire), /invalid_payload/);
    assert.equal(validateSaved(wire).valid, false);
  }
});

test('zero to two canonical CCs after manager and employee privacy exclusions preserve the exact provider binding', () => {
  for (const count of [0, 1, 2]) {
    const wire = payload();
    if (count < 2) wire.recipient = wire.ccRecipients.shift();
    if (count === 0) wire.ccRecipients = [];
    assert.doesNotThrow(() => loadMailHarness().mail.validatePerformanceReviewMailPayload(wire));
    const saved = validateSaved(wire);
    assert.equal(saved.valid, true);
    assert.deepEqual(saved.graphBody.message.toRecipients, [{ emailAddress: { address: wire.recipient } }]);
    assert.deepEqual(saved.graphBody.message.ccRecipients, wire.ccRecipients.map(address => ({ emailAddress: { address } })));
    assert.deepEqual(saved.graphBody.message.bccRecipients, []);
    assert.deepEqual(saved.beginBody.ccRecipients, wire.ccRecipients);
    assert.deepEqual(saved.binding.actualRecipients, [wire.recipient, ...wire.ccRecipients]);
  }
});

test('database claims with an invalid or omitted CC set stay held before any webhook request', async () => {
  for (const cc of invalidCc()) {
    const row = fixture();
    if (cc === undefined) delete row.payload.ccRecipients;
    else row.payload.ccRecipients = cc;
    const h = loadMailHarness({ rpc: name => ({ data: name === 'claim_performance_review_mail' ? [row] : true, error: null }) });
    const result = await h.mail.dispatchPerformanceReviewMailOutbox();
    assert.equal(result.providerAccepted, 0); assert.equal(result.held, 1);
    assert.equal(h.requests.length, 0); assert.equal(h.calls.length, 1);
  }
});

test('HTTP begin rejects the former manager-only contract and unsafe CCs before constructing a service client', async () => {
  const h = loadMailHarness();
  for (const cc of invalidCc()) {
    const body = begin();
    if (cc === undefined) delete body.ccRecipients;
    else body.ccRecipients = cc;
    const response = await h.route().POST(request('POST', body));
    assert.equal(response.status, 400); assert.deepEqual(await response.json(), { ok: false, code: 'invalid_request' });
  }
  assert.equal(h.clients, 0); assert.equal(h.calls.length, 0);
});

test('HTTP begin accepts bounded maximum-length addresses and binds every recipient through the final-mail RPC', async () => {
  const address = letter => letter.repeat(254 - '@mobilityaccess.com.au'.length) + '@mobilityaccess.com.au';
  const body = { ...begin(), recipient: address('m'), ccRecipients: [address('r'), address('s')] };
  assert.ok(JSON.stringify(body).length <= 1024);
  const h = loadMailHarness({ rpc(name, args) {
    assert.equal(name, 'begin_performance_review_final_mail');
    assert.deepEqual(args, { p_delivery_id: body.deliveryId, p_claim_token: body.claimToken, p_attachment_sha256: body.attachmentSha256,
      p_recipient: body.recipient, p_cc_recipients: body.ccRecipients });
    return { data: true, error: null };
  } });
  const response = await h.route().POST(request('POST', body));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, allowed: true });
  assert.deepEqual(h.rpcRetries, [false]);
});

test('a named manager final attachment accepts the exact receipt with zero or one remaining reviewer CC', async () => {
  for (const cc of [[], ['reviewer-two@mobilityaccess.com.au']]) {
    const row = fixture(); row.payload.recipient = 'reviewer-one@mobilityaccess.com.au'; row.payload.ccRecipients = cc;
    const h = loadMailHarness({ rpc: name => ({ data: name === 'claim_performance_review_mail' ? [row] : true, error: null }),
      fetch: (_, init) => ack(JSON.parse(init.body)) });
    const result = await h.mail.dispatchPerformanceReviewMailOutbox();
    assert.equal(result.providerAccepted, 1); assert.equal(h.requests.length, 1);
  }
});


test('HTTP begin passes a present empty CC set to the database for exact privacy-bound authorization', async () => {
  const body = { ...begin(), ccRecipients: [] };
  for (const allowed of [false, true]) {
    const h = loadMailHarness({ rpc(name, args) {
      assert.equal(name, 'begin_performance_review_final_mail'); assert.deepEqual(args.p_cc_recipients, []);
      return { data: allowed, error: null };
    } });
    const response = await h.route().POST(request('POST', body));
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, allowed });
  }
});
