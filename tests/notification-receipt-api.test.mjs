import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const receiptModule = { exports: {} };
new Function('require', 'module', 'exports', ts.transpileModule(readFileSync('src/lib/notification-receipts.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(id => id === 'server-only' ? {} : require(id), receiptModule, receiptModule.exports);
const { handleNotificationReceipts: handle, NOTIFICATION_RECEIPTS_PATH: path } = receiptModule.exports;
const secret = 'synthetic-notification-secret-'.repeat(3);
const id = '10000000-0000-4000-8000-000000000001';
const token = '20000000-0000-4000-8000-000000000001';
const key = `leave:${id}:leave-submitted:${'a'.repeat(24)}`;
const input = { action: 'reserve', eventKey: key, recipient: 'manager@example.test', cc: '', legacyEventKey: null };
const provider = { accepted: true, messageId: 'synthetic-id', requestId: null, statusCode: 202 };
const ack = { ok: true, sent: true, alreadySent: false, eventKey: key,
  actualRecipient: input.recipient, actualCcRecipients: '', providerReceipt: provider };
const confirmation = { action: 'confirm', eventKey: key, recipient: input.recipient, cc: '', deliveryToken: token, providerReceipt: provider };
function request(body = input, options = {}) {
  const { headers, method = 'POST', url = 'https://example.test' + path, ...rest } = options;
  return new Request(url, { method, headers: { 'content-type': 'application/json', 'x-mam-notification-secret': secret, ...headers },
    ...(method !== 'GET' ? { body: JSON.stringify(body) } : {}), ...rest });
}
function harness(result = { outcome: 'send', eventKey: key, deliveryToken: token }) {
  const calls = [];
  return { calls, run: (req = request(), configured = secret) => handle(req, configured, async (name, args) => {
    calls.push({ name, args });
    if (result instanceof Error) throw result;
    return { data: result, error: null };
  }) };
}

test('receipt integration fails closed before privileged access without the configured matching secret', async () => {
  let accessed = false;
  const absent = await handle(request(), undefined, async () => { accessed = true; throw Error('must not call'); });
  assert.equal(absent.status, 503); assert.equal(accessed, false);
  for (const [configured, provided, expected] of [['', secret, 503], ['short', secret, 503],
    [secret, '', 401], [secret, 'wrong', 401], [secret, 'x'.repeat(513), 401]]) {
    const h = harness();
    const response = await h.run(request(input, { headers: { 'x-mam-notification-secret': provided } }), configured);
    assert.equal(response.status, expected);
    assert.equal(h.calls.length, 0);
  }
});

test('only the exact cookie-less, origin-less server route can reach the receipt store', async () => {
  for (const options of [{ headers: { origin: 'https://example.test' } }, { headers: { cookie: 'synthetic=session' } },
    { url: 'https://example.test' + path + '?secret=synthetic' }, { url: 'https://example.test' + path + '/other' },
    { headers: { 'content-type': 'text/plain' } }, { method: 'DELETE' }]) {
    const h = harness(); const r = await h.run(request(input, options));
    assert.ok([400, 405].includes(r.status)); assert.equal(h.calls.length, 0);
    assert.match(r.headers.get('cache-control'), /no-store/);
    assert.equal(r.headers.get('access-control-allow-origin'), null);
  }
});

test('reserve validates and canonicalizes every recipient without accepting extra fields', async () => {
  const h = harness();
  const result = await h.run(request({ ...input, recipient: 'B@example.test,a@example.test,b@example.test', cc: ' C@example.test ' }));
  assert.equal(result.status, 200);
  assert.deepEqual(h.calls, [{ name: 'reserve_notification_delivery', args: {
    p_event_key: key, p_recipient: 'a@example.test,b@example.test', p_cc: 'c@example.test', p_legacy_event_key: null,
  } }]);
  assert.deepEqual(await result.json(), { outcome: 'send', eventKey: key, deliveryToken: token });
  for (const patch of [{ recipient: '' }, { recipient: 'valid@example.test,not-an-address' }, { cc: 'bad\r\nBcc:other@example.test' },
    { recipient: 'a@example.test,,b@example.test' }, { employeeNote: 'do not retain' }, { emailHtml: '<p>private</p>' },
    { action: 'reset' }, { eventKey: 'constructor' }, { legacyEventKey: `leave:${id}:leave-approved:${'b'.repeat(24)}` },
    { legacyEventKey: key }, { recipient: Array.from({ length: 33 }, (_, i) => `p${i}@example.test`).join(',') }]) {
    const bad = harness(); assert.equal((await bad.run(request({ ...input, ...patch }))).status, 400); assert.equal(bad.calls.length, 0);
  }
});

test('all supported key families pass and unrelated legacy/shared keys fail', async () => {
  for (const eventKey of [`payroll-comparison:${id}`, `payroll-balance:${id}:2026-10`, `leave:${id}:team-birthday:${'b'.repeat(24)}`,
    `new-starter:${id}:day-one:test`, `new-starter:${id}:day-one:live`,
    `checkin:${id}:5-month:initial:test`, `checkin:${id}:2-week:initial:live`,
    `checkin:${id}:6-month:initial:test`, `checkin:${id}:6-month:initial:live`,
    `checkin:${id}:6-month-casual:initial:test`, `checkin:${id}:6-month-casual:initial:live`,
    `onboarding-credential:${id}`,
    `checkin-review:${id}:hr:1:test`, `checkin-review:${id}:hr:9:live`]) {
    const h = harness({ outcome: 'send', eventKey, deliveryToken: token });
    assert.equal((await h.run(request({ ...input, eventKey }))).status, 200);
  }
  for (const eventKey of [`payroll-balance:${id}:2026-13`, `leave:${id}:unknown:${'b'.repeat(24)}`, `payroll-comparison:${id}:extra`,
    `new-starter:${id}:day-one:preview`, `new-starter:${id}:day-two:live`,
    `checkin:${id}:5-month:final:test`, `checkin:${id}:5_month:initial:test`,
    `checkin:${id}:5-month:initial:preview`, `checkin:${id}:6-month-casual:final:live`,
    `checkin:${id}:6-month-contract:initial:live`, `checkin-review:${id}:hr:0:test`,
    `checkin-review:${id}:manager:1:live`]) {
    const h = harness(); assert.equal((await h.run(request({ ...input, eventKey }))).status, 400); assert.equal(h.calls.length, 0);
  }
  const legacy = `leave:${id}:leave-submitted:${'b'.repeat(24)}`;
  const h = harness(); assert.equal((await h.run(request({ ...input, legacyEventKey: legacy }))).status, 200);
  assert.equal(h.calls[0].args.p_legacy_event_key, legacy);
});

test('unknown reserve responses never retry or turn into a send grant', async () => {
  for (const result of [new Error('sensitive database error'), null, {}, [{ deliveryToken: token }],
    { outcome: 'send', eventKey: key, deliveryToken: 'wrong' }, { outcome: 'send', eventKey: key, deliveryToken: token, ok: false },
    { outcome: 'send', eventKey: 'wrong', deliveryToken: token }, { ...ack, outcome: 'duplicate', sent: false, alreadySent: true, actualRecipient: 'other@example.test' }]) {
    const h = harness(result); const response = await h.run();
    assert.equal(response.status, 503); assert.equal(h.calls.length, 1);
    assert.deepEqual(await response.json(), { ok: false, code: 'unavailable' });
  }
});

test('duplicates preserve original evidence; mismatched and legacy receipts remain rejected', async () => {
  const duplicate = { ...ack, outcome: 'duplicate', sent: false, alreadySent: true };
  assert.deepEqual(await (await harness(duplicate).run()).json(), duplicate);
  for (const rejectionCode of ['receipt-recipient-mismatch', 'receipt-evidence-unavailable', 'legacy-receipt-reconciliation', 'receipt-delivery-unknown', 'delivery-in-flight']) {
    const result = { outcome: 'rejected', ok: false, sent: false, alreadySent: false, eventKey: key,
      rejectionCode, reconciliationRequired: true, actualRecipient: 'original@example.test', actualCcRecipients: 'old@example.test', providerReceipt: provider,
      privateNotes: 'must never appear', deliveryToken: token };
    const response = await (await harness(result).run()).json();
    assert.equal(response.rejectionCode, rejectionCode); assert.equal(response.actualRecipient, 'original@example.test');
    assert.equal(response.ok, false); assert.equal(response.privateNotes, undefined); assert.equal(response.deliveryToken, undefined);
  }
  const disabled = { outcome: 'rejected', ok: false, sent: false, alreadySent: false, eventKey: key,
    rejectionCode: 'receipt-store-not-ready', reconciliationRequired: false };
  assert.equal((await harness(disabled).run()).status, 503);
});

test('confirmation is bound to the original token and minimal successful provider acknowledgement', async () => {
  const h = harness(ack); const response = await h.run(request(confirmation));
  assert.deepEqual(await response.json(), ack);
  assert.deepEqual(h.calls, [{ name: 'confirm_notification_delivery', args: {
    p_event_key: key, p_recipient: input.recipient, p_cc: '', p_delivery_token: token, p_provider_receipt: provider,
  } }]);
  for (const patch of [{ deliveryToken: '' }, { providerReceipt: { ...provider, accepted: false } },
    { providerReceipt: { ...provider, statusCode: 500 } }, { providerReceipt: { ...provider, statusCode: 302 } },
    { providerReceipt: { ...provider, responseBody: 'private' } }, { providerReceipt: { ...provider, messageId: 'x\nprivate' } },
    { providerReceipt: { ...provider, messageId: 'x'.repeat(1025) } }]) {
    const bad = harness(); assert.equal((await bad.run(request({ ...confirmation, ...patch }))).status, 400); assert.equal(bad.calls.length, 0);
  }
  const changed = harness({ ...ack, providerReceipt: { ...provider, messageId: 'different' } });
  assert.equal((await changed.run(request(confirmation))).status, 503);
});

test('bounded streamed bodies and malformed JSON/UTF8 never access the database', async () => {
  for (const options of [{ body: '{bad' }, { body: 'x'.repeat(16385) }, { headers: { 'content-length': '20000' }, body: '{}' },
    { body: new Uint8Array([0xff]) }, { body: '[]' }]) {
    const h = harness(); const response = await h.run(request(input, options));
    assert.ok([400, 413].includes(response.status)); assert.equal(h.calls.length, 0);
  }
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(16385)); }, cancel() { cancelled = true; } });
  const h = harness(); assert.equal((await h.run(request(input, { body: stream, duplex: 'half' }))).status, 413);
  assert.equal(cancelled, true); assert.equal(h.calls.length, 0);
});

test('authenticated readiness reads only the status RPC and exposes no receipts', async () => {
  const h = harness({ version: 1, ready: false, secret: 'must never appear' });
  const response = await h.run(request(null, { method: 'GET' }));
  assert.deepEqual(await response.json(), { version: 1, ready: false });
  assert.deepEqual(h.calls, [{ name: 'notification_delivery_store_status', args: {} }]);
  assert.equal((await harness(null).run(request(null, { method: 'GET' }))).status, 503);
});

test('route wires bounded admin RPCs and proxy bypass is exact, not an integration subtree', () => {
  const route = readFileSync('src/app/api/internal/integrations/notifications/receipts/route.ts', 'utf8');
  assert.match(route, /abortSignal\(AbortSignal\.timeout\(8000\)\)/);
  assert.match(route, /MAM_N8N_LEAVE_WEBHOOK_SECRET/);
  const proxy = readFileSync('src/proxy.ts', 'utf8');
  assert.ok(proxy.includes(`pathname === "${path}"`));
  assert.ok(!proxy.includes(`pathname.startsWith("/api/internal/integrations/notifications`));
});
