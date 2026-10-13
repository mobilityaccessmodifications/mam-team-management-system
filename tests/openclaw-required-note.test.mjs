import assert from 'node:assert/strict';
import test from 'node:test';
import { createCipheriv, createHash, createHmac } from 'node:crypto';
import { fixture, employee, now, config, input } from './openclaw-v3-fixture.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
function legacyToken() {
  const person = employee();
  const request = input();
  const fields = { leaveType: request.leaveType, startDate: request.startDate, endDate: request.endDate, startTime: null, endTime: null, employeeNote: '' };
  const summary = `Please review your leave request:\nName: ${person.fullName}\nDates: ${fields.startDate}\nType: ${fields.leaveType}\nNote (optional): None`;
  const draft = { id: 'e5000000-0000-4000-8000-000000000001', identity: { account: config.account, sender: person.phone, session: 'synthetic' },
    personId: person.personId, userId: person.userId, phoneIdentityVersion: person.phoneIdentityVersion, fields, summary, digest: hash(summary),
    challenge: 'e5000000-0000-4000-8000-000000000002', consentVersion: 3, employmentType: person.employmentType,
    fullName: person.fullName, issuedAt: now, expiresAt: now + 600000 };
  const domain = 'mam-openclaw-leave:v3:draft:aes-256-gcm', iv = Buffer.alloc(12, 1);
  const cipher = createCipheriv('aes-256-gcm', createHmac('sha256', config.key).update(domain).digest(), iv);
  cipher.setAAD(Buffer.from(domain));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(draft), 'utf8'), cipher.final()]);
  return { draft, token: 'v3.' + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url') };
}

test('assistant preparation asks for the missing employee note without inventing one or writing', async () => {
  for (const employeeNote of [undefined, null, '', ' ', '\t\r\n', '\u00a0\u2003\ufeff']) {
    const f = fixture();
    const result = await f.call(f.packet('prepare', { ...input(), employeeNote }));
    assert.equal(result.status, 200);
    assert.equal(result.body.code, 'needs_input');
    assert.deepEqual(result.body.missing, ['employeeNote']);
    assert.equal('draftToken' in result.body, false);
    assert.equal(f.writes(), 0);
  }
});
test('assistant nonblank note summary is required and preserves size and safety checks', async () => {
  const f = fixture();
  const result = await f.call(f.packet('prepare', { ...input(), employeeNote: '  Synthetic note <&>  ' }));
  assert.equal(result.body.code, 'prepared');
  assert.match(result.body.summary, /Note: Synthetic note <&>/);
  assert.doesNotMatch(result.body.summary, /optional|None/);
  assert.equal((await f.call(f.packet('prepare', { ...input(), employeeNote: 'x'.repeat(2000) }))).body.code, 'prepared');
  for (const employeeNote of ['x'.repeat(2001), 'bad\u202e', 'bad\u0000', false, 7]) {
    assert.equal((await f.call(f.packet('prepare', { ...input(), employeeNote }))).status, 400);
  }
  assert.equal(f.writes(), 0);
});
test('a delivered legacy blank draft cannot create a new request', async () => {
  const { token } = legacyToken(), f = fixture();
  const result = await f.call(f.packet('confirm', { draftToken: token, shownMessageId: 'provider-1', replyToMessageId: null, text: 'Confirm' }), now + 1);
  assert.equal(result.body.code, 'needs_input');
  assert.deepEqual(result.body.missing, ['employeeNote']);
  assert.equal(f.writes(), 0);
});
test('committed legacy blank draft can safely reconcile through the locked receipt path after expiry', async () => {
  const { draft, token } = legacyToken();
  const result = { code: 'submitted', requestId: 'e5000000-0000-4000-8000-000000000003', status: 'Pending' };
  let submits = 0;
  const f = fixture({
    async snapshot() { return { complete: true, rows: [employee()], fingerprint: 'a'.repeat(64), receipt: null,
      submitted: { identity: draft.identity, personId: draft.personId, userId: draft.userId, tokenHash: hash(token), result } }; },
    async submit(plan) { submits++; assert.equal(plan.draft.fields.employeeNote, ''); assert.equal(plan.tokenHash, hash(token)); return result; },
  });
  assert.deepEqual((await f.call(f.packet('confirm', { draftToken: token, shownMessageId: 'provider-1', replyToMessageId: null, text: 'Confirm' }), now + 600001)).body, result);
  assert.equal(submits, 1);
});
