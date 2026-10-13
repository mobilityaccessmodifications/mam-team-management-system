import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { buildCheckInReminderWorkflow } from '../scripts/build-check-in-reminder-workflow.mjs';
import { buildNewStarterDayOneWorkflow } from '../scripts/build-new-starter-day-one-workflow.mjs';
import { buildOnboardingCredentialWorkflow } from '../scripts/build-onboarding-credential-workflow.mjs';

const credential = { id: 'Ug5bTBjvF1vCSdhQ', name: 'Microsoft Outlook - ai@mobilityaccess.com.au' };
const cases = [
  ['Day 1 test', () => buildNewStarterDayOneWorkflow({ mode: 'test' }), 1,
    'e81865fed47e564b840408fee33aa0b3bc62f60217c9815e99a06ef6d58c8b26'],
  ['Day 1 live', () => buildNewStarterDayOneWorkflow({ mode: 'live' }), 1,
    'a116b444352eb972d83b6f327bd9817638f4d69653a5468151a7df26fc67cc17'],
  ['Check-In test', () => buildCheckInReminderWorkflow({ mode: 'test' }), 8,
    '405e65cfd44fe6cedce41fe6e197bf55bcb920ffce5e01111a63e02977a3be88'],
  ['Check-In live', () => buildCheckInReminderWorkflow({ mode: 'live' }), 8,
    '17c4484d686fdcbfaeac9a8e7015a30ae64695dc84451fb381a19b3d0978468f'],
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
