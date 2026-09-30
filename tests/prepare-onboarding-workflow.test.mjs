import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareInactiveWorkflow } from '../scripts/prepare-onboarding-workflow.mjs';

test('prepares a workflow without activation using only the verified credential reference', () => {
  const flow = prepareInactiveWorkflow({ credentialId: 'synthetic-id', credentialName: 'MAM People Hub - Onboarding Webhook Header' });
  assert.equal(flow.active, false);
  const webhook = flow.nodes.find(node => node.type === 'n8n-nodes-base.webhook');
  assert.equal(webhook.credentials.httpHeaderAuth.id, 'synthetic-id');
  assert.equal(webhook.parameters.path, 'mam-people-hub-onboarding-credentials-v1');
  assert.equal(flow.settings.saveDataSuccessExecution, 'none');
});

test('refuses an unverified or ambiguous credential reference', () => {
  for (const value of [undefined, '../other', '']) {
    assert.throws(() => prepareInactiveWorkflow({ credentialId: value, credentialName: 'MAM People Hub - Onboarding Webhook Header' }));
  }
  assert.throws(() => prepareInactiveWorkflow({ credentialId: 'synthetic-id', credentialName: 'Other company' }));
});
