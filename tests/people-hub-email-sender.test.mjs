import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { buildCheckInReminderWorkflow } from '../scripts/build-check-in-reminder-workflow.mjs';
import { buildNewStarterDayOneWorkflow } from '../scripts/build-new-starter-day-one-workflow.mjs';
import { buildOnboardingCredentialWorkflow } from '../scripts/build-onboarding-credential-workflow.mjs';

const credential = { id: 'Ug5bTBjvF1vCSdhQ', name: 'Microsoft Outlook - ai@mobilityaccess.com.au' };
const cases = [
  ['Day 1 test', () => buildNewStarterDayOneWorkflow({ mode: 'test' }), 1,
    'e80e5c9ae9c23f8a5cf0438f49f70871ee148ebe8243b10ac8cab26260845a4f'],
  ['Day 1 live', () => buildNewStarterDayOneWorkflow({ mode: 'live' }), 1,
    '3ed014cb9030ef3cd3d7184fd1cdf331c18763037a5cee0849670b6112e40bae'],
  ['Check-In test', () => buildCheckInReminderWorkflow({ mode: 'test' }), 8,
    '8fc7ab9fb6f20270ec00972c234bf550093e4731742bd16eb1873d99497a2e71'],
  ['Check-In live', () => buildCheckInReminderWorkflow({ mode: 'live' }), 8,
    'f6c3172304a52757c05504f4ec57bc002487ab3fbf987115191d6e2db092161e'],
  ['Onboarding credentials', () => buildOnboardingCredentialWorkflow({
    webhookCredential: { id: 'synthetic-webhook', name: 'Synthetic webhook' },
  }), 1, '52949cc375551d5a973f0501f0522ea44614254e7eceb01a8592bc64cf1368a2'],
];

function assertNoSenderOverride(parameters) {
  if (!parameters || typeof parameters !== 'object') return;
  for (const [key, value] of Object.entries(parameters)) {
    assert.doesNotMatch(key, /^(?:from|sender|replyTo)/i);
    assertNoSenderOverride(value);
  }
}

for (const [name, build, count, payloadSha256] of cases) {
  test(`${name} sends through AI Outlook and preserves the complete remaining workflow`, () => {
    const workflow = build();
    const senders = workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.microsoftOutlook'
      && node.parameters.operation === 'send');
    assert.equal(senders.length, count);
    for (const sender of senders) {
      assert.deepEqual(sender.credentials.microsoftOutlookOAuth2Api, credential);
      assertNoSenderOverride(sender.parameters);
    }
    const payload = structuredClone(workflow);
    for (const node of payload.nodes) {
      if (node.type === 'n8n-nodes-base.microsoftOutlook' && node.parameters.operation === 'send') {
        delete node.credentials.microsoftOutlookOAuth2Api;
      }
    }
    assert.equal(createHash('sha256').update(JSON.stringify(payload)).digest('hex'), payloadSha256);
  });
}
