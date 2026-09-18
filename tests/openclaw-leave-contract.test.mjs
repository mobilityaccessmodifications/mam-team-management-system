import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const crypto = require('node:crypto');
function load(file, imports) {
  const code = require('typescript').transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: require('typescript').ModuleKind.CommonJS, target: require('typescript').ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(id => {
    if (!(id in imports)) throw new Error('Unexpected import ' + id);
    return imports[id];
  }, mod, mod.exports);
  return mod.exports;
}
const phone = load('src/lib/openclaw-allowlist.ts', { 'server-only': {}, 'node:crypto': crypto, 'libphonenumber-js/max': require('libphonenumber-js/max') });
const api = load('src/lib/openclaw-leave-contract.ts', { 'server-only': {}, 'node:crypto': crypto, './openclaw-allowlist': phone });
const config = { key: 'synthetic-only-key-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', account: 'mam-test' };
const baseTime = Date.parse('2026-09-18T01:00:00Z');
const personId = '10000000-0000-4000-8000-000000000001';
const userId = '20000000-0000-4000-8000-000000000001';
const employee = () => ({ personId, userId, company: 'mam', active: true, nodeKind: 'person', accountActive: true, phone: '0400000001', country: 'Australia', fullName: 'Synthetic Employee', employmentType: 'full_time' });
const input = () => ({ leaveType: 'Annual leave', startDate: '2026-10-12', endDate: '2026-10-12', employeeNote: '' });
// Synthetic adapter ONLY. Serializes concurrent requests and rolls back all
// mutations. It is not a persistence implementation or proof of DB isolation.
function fixture() {
  let rows = [employee()], state = { receipts: new Map(), drafts: new Map(), leaves: [] };
  let queue = Promise.resolve();
  let calls = 0, profileReads = 0;
  const store = {
    async selfProfileEmployees() {
      profileReads++;
      return { complete: true, rows: structuredClone(rows) };
    },
    transaction(work) {
    const run = queue.then(async () => {
      calls++;
      const next = structuredClone(state);
      const result = await work({
        employees: async () => ({ complete: true, rows: structuredClone(rows) }),
        receipt: async key => next.receipts.get(key) ?? null,
        saveReceipt: async (key, fingerprint, p, result) => next.receipts.set(key, { fingerprint, personId: p.personId, userId: p.userId, result }),
        draft: async id => next.drafts.get(id) ?? null,
        saveDraft: async draft => next.drafts.set(draft.id, draft),
        submitSelf: async (p, fields, draftId) => {
          const exists = next.leaves.find(r => r.draftId === draftId);
          if (exists) return exists.result;
          if (next.leaves.some(r => r.personId === p.personId && r.fields.startDate <= fields.endDate && r.fields.endDate >= fields.startDate)) throw new Error('synthetic overlap; private details');
          const result = { requestId: crypto.randomUUID(), status: 'Pending' };
          next.leaves.push({ personId: p.personId, userId: p.userId, fields, draftId, result });
          return result;
        },
      });
      state = next;
      return result;
    });
    queue = run.catch(() => {});
    return run;
    },
  };
  let sequence = 0;
  const packet = (operation, payload, overrides = {}) => ({ version: 1, account: config.account, channel: 'whatsapp', sender: '+61400000001', session: 'self-session', eventId: 'event-' + ++sequence, operation, payload, ...overrides });
  const call = (p, now = baseTime, options = {}) => {
    const raw = JSON.stringify(p), timestamp = String(options.timestamp ?? now);
    const signature = options.signature ?? crypto.createHmac('sha256', config.key).update(`POST\n${api.LEAVE_BRIDGE_PATH}\n${timestamp}\n${raw}`).digest('hex');
    return api.handleLeaveBridge(raw, timestamp, signature, options.config ?? config, store, now);
  };
  async function ready() {
    const prepared = await call(packet('prepare', input()));
    assert.equal(prepared.body.code, 'prepared');
    const d = prepared.body;
    const shown = await call(packet('shown', { draftId: d.draftId, digest: d.digest, outboundMessageId: 'out-1' }));
    assert.equal(shown.body.code, 'shown');
    return { d, confirm: packet('confirm', { draftId: d.draftId, digest: d.digest, replyToMessageId: 'out-1', text: d.summary.match(/CONFIRM [a-f0-9-]+/)[0] }) };
  }
  return { packet, call, ready, setRows: r => { rows = r; }, state: () => state, calls: () => calls, profileReads: () => profileReads };
}

test('unauthenticated, expired, wrong-account/channel packets never enter transaction', async () => {
  const f = fixture(), p = f.packet('prepare', input());
  assert.equal((await f.call(p, baseTime, { signature: '0'.repeat(64) })).status, 401);
  assert.equal((await f.call(p, baseTime, { timestamp: baseTime - 61000 })).status, 401);
  assert.equal((await f.call({ ...p, account: 'other' })).status, 401);
  assert.equal((await f.call({ ...p, channel: 'group' })).status, 401);
  assert.equal((await f.call(p, baseTime, { config: { ...config, key: '' } })).status, 503);
  assert.equal(f.calls(), 0);
  assert.equal(f.profileReads(), 0);
});
test('self profile returns only the uniquely matched sender name and employment type without a write transaction', async () => {
  const f = fixture();
  const second = { ...employee(), personId: crypto.randomUUID(), userId: crypto.randomUUID(), phone: '0400000002', fullName: 'Second Employee', employmentType: 'casual' };
  f.setRows([employee(), second]);
  const result = await f.call(f.packet('profile', {}, { sender: '+61400000002' }));
  assert.deepEqual(result, { status: 200, body: { code: 'profile', profile: { name: 'Second Employee', employmentType: 'casual' } } });
  assert.deepEqual(Object.keys(result.body.profile).sort(), ['employmentType', 'name']);
  assert.equal(f.calls(), 0);
  assert.equal(f.profileReads(), 1);
});
test('model cannot supply identity or approve/reject/cancel/edit fields', async () => {
  for (const field of ['employeeId', 'userId', 'phone', 'confirmed', 'status', 'hours']) {
    const f = fixture();
    assert.equal((await f.call(f.packet('prepare', { ...input(), [field]: 'bad' }))).status, 400);
    assert.equal((await f.call(f.packet('profile', { [field]: 'bad' }))).status, 400);
    assert.equal(f.profileReads(), 0);
    assert.equal(f.state().leaves.length, 0);
  }
  for (const operation of ['approve', 'reject', 'cancel', 'update', 'submit']) {
    const f = fixture();
    assert.equal((await f.call(f.packet(operation, {}))).status, 400);
  }
});
test('missing fields produce follow-up fields; invalid dates/times/notes reject', async () => {
  const f = fixture();
  assert.deepEqual((await f.call(f.packet('prepare', {}))).body, { code: 'needs_input', missing: ['leaveType', 'startDate', 'endDate'] });
  for (const change of [{ startDate: '2026-02-30' }, { endDate: '2026-01-01' }, { endDate: '2028-10-12' }, { startTime: '12:01', endTime: '16:00' }, { startTime: '12:00', endTime: '11:00' }, { employeeNote: 'x'.repeat(2001) }, { employeeNote: '\u202eHidden' }, { startDate: '2026-10-10', endDate: '2026-10-11' }]) {
    assert.equal((await f.call(f.packet('prepare', { ...input(), ...change }))).status, 400);
  }
  assert.deepEqual((await f.call(f.packet('prepare', { ...input(), startTime: '12:00' }))).body.missing, ['endTime']);
  assert.equal(f.state().leaves.length, 0);
});
test('unknown, inactive, other company, unlinked and shared numbers all fail closed', async () => {
  for (const rows of [[], [{ ...employee(), active: false }], [{ ...employee(), company: 'equipsy' }], [{ ...employee(), userId: null }], [{ ...employee(), accountActive: false }], [{ ...employee(), nodeKind: 'unit' }], [employee(), { ...employee(), userId: null, phone: '+61400000001' }]]) {
    const f = fixture(); f.setRows(rows);
    assert.deepEqual((await f.call(f.packet('prepare', input()))).body, { code: 'not_available' });
    assert.deepEqual((await f.call(f.packet('profile', {}))).body, { code: 'not_available' });
    assert.equal(f.state().leaves.length, 0);
  }
});
test('self profile fails closed for missing or malformed identity attributes', async () => {
  for (const change of [{ fullName: '' }, { fullName: '\u202eHidden' }, { employmentType: 'contractor' }]) {
    const f = fixture(); f.setRows([{ ...employee(), ...change }]);
    assert.deepEqual((await f.call(f.packet('profile', {}))).body, { code: 'not_available' });
  }
});
test('casual/unclassified cannot request paid leave; unpaid is allowed', async () => {
  for (const employmentType of ['casual', 'abn', null]) {
    const f = fixture(); f.setRows([{ ...employee(), employmentType }]);
    assert.equal((await f.call(f.packet('prepare', input()))).status, 409);
    assert.equal((await f.call(f.packet('prepare', { ...input(), leaveType: 'Unpaid leave' }))).body.code, 'prepared');
  }
});
test('inclusive calendar range permits 366 days but rejects 367 across a leap year', async () => {
  const f = fixture();
  assert.equal((await f.call(f.packet('prepare', { ...input(), startDate: '2028-01-01', endDate: '2028-12-31' }))).status, 200);
  assert.equal((await f.call(f.packet('prepare', { ...input(), startDate: '2028-01-01', endDate: '2029-01-01' }))).status, 400);
});
test('prepare is not a submission; exact summary, display receipt and explicit confirmation are required', async () => {
  const f = fixture(), d = (await f.call(f.packet('prepare', input()))).body;
  assert.match(d.summary, /7\.60 hours/);
  assert.equal(f.state().leaves.length, 0);
  const payload = { draftId: d.draftId, digest: d.digest, replyToMessageId: 'out-1', text: d.summary.match(/CONFIRM [a-f0-9-]+/)[0] };
  assert.equal((await f.call(f.packet('confirm', payload), baseTime + 1000)).status, 409);
  await f.call(f.packet('shown', { draftId: d.draftId, digest: d.digest, outboundMessageId: 'out-1' }));
  for (const bad of [{ text: 'yes' }, { digest: '0'.repeat(64) }, { replyToMessageId: 'different' }]) {
    assert.equal((await f.call(f.packet('confirm', { ...payload, ...bad }), baseTime + 1000)).status, 409);
  }
  assert.equal((await f.call(f.packet('confirm', payload), baseTime + 1000)).body.status, 'Pending');
  assert.equal(f.state().leaves[0].personId, personId);
});
test('confirmation cannot cross sender/session; expired and changed-identity/policy drafts fail closed', async () => {
  for (const variant of ['sender', 'session', 'expired', 'reassigned', 'employment', 'inactive', 'duplicate']) {
    const f = fixture(), { confirm } = await f.ready();
    let now = baseTime + 1000;
    if (variant === 'sender') { confirm.sender = '+61400000002'; f.setRows([employee(), { ...employee(), phone: '0400000002', personId: crypto.randomUUID(), userId: crypto.randomUUID() }]); }
    if (variant === 'session') confirm.session = 'another-session';
    if (variant === 'expired') now += 600000;
    if (variant === 'reassigned') f.setRows([{ ...employee(), personId: crypto.randomUUID(), userId: crypto.randomUUID() }]);
    if (variant === 'employment') f.setRows([{ ...employee(), employmentType: 'part_time' }]);
    if (variant === 'inactive') f.setRows([{ ...employee(), active: false }]);
    if (variant === 'duplicate') f.setRows([employee(), { ...employee(), phone: '+61400000001' }]);
    assert.equal((await f.call(confirm, now)).status, 409, variant);
    assert.equal(f.state().leaves.length, 0);
  }
});
test('concurrent retries and fresh event retries submit once; changed replay payload is conflict', async () => {
  const f = fixture(), { confirm } = await f.ready();
  const replies = await Promise.all(Array.from({ length: 12 }, () => f.call(confirm, baseTime + 1000)));
  assert.ok(replies.every(r => r.status === 200 && r.body.requestId === replies[0].body.requestId));
  assert.equal(f.state().leaves.length, 1);
  assert.equal((await f.call({ ...confirm, eventId: 'fresh-confirm' }, baseTime + 2000)).body.requestId, replies[0].body.requestId);
  assert.equal((await f.call({ ...confirm, eventId: 'after-ttl' }, baseTime + 20 * 60000)).body.requestId, replies[0].body.requestId);
  assert.equal(f.state().leaves.length, 1, 'Expired completed retries cannot insert');
  assert.equal((await f.call({ ...confirm, payload: { ...confirm.payload, text: 'no' } }, baseTime + 1000)).status, 409);
});
test('new draft cannot duplicate overlapping leave; private store errors are sanitized', async () => {
  const f = fixture(), first = await f.ready();
  await f.call(first.confirm, baseTime + 1000);
  const second = await f.ready();
  const result = await f.call(second.confirm, baseTime + 2000);
  assert.deepEqual(result, { status: 503, body: { code: 'unavailable' } });
  assert.equal(f.state().leaves.length, 1);
  assert.equal(f.state().drafts.get(second.d.draftId).result, undefined);
});
test('replayed successful receipt cannot be revealed after number reassignment', async () => {
  const f = fixture(), { confirm } = await f.ready();
  await f.call(confirm, baseTime + 1000);
  f.setRows([{ ...employee(), personId: crypto.randomUUID(), userId: crypto.randomUUID() }]);
  assert.equal((await f.call(confirm, baseTime + 2000)).status, 409);
});
test('contract never dispatches mail or accesses credentials itself', () => {
  const code = fs.readFileSync('src/lib/openclaw-leave-contract.ts', 'utf8');
  assert.doesNotMatch(code, /createAdminClient|dispatchLeaveNotifications|process\.env|fetch\(/);
});
