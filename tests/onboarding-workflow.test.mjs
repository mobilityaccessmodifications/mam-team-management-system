import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOnboardingCredentialWorkflow } from '../scripts/build-onboarding-credential-workflow.mjs';

test('credential workflow validates employee-only recipients and never includes manager', () => {
  const workflow = buildOnboardingCredentialWorkflow();
  const validator = new Function('$input', workflow.nodes.find((node) => node.name === 'Validate Credential Request').parameters.jsCode);
  const id = '10000000-0000-4000-8000-000000000004';
  const [valid] = validator({ first: () => ({ json: { body: { version: 1, deliveryId: id, login: 'work@example.test', temporaryPassword: 'synthetic-long-enough-password', workEmail: 'work@example.test', personalEmail: 'home@example.test', recipients: ['work@example.test', 'home@example.test'] } } }) });
  assert.equal(valid.json.valid, true);
  assert.equal(valid.json.actualRecipient, 'work@example.test,home@example.test');
  assert.ok(typeof valid.json.temporaryPassword === 'string' && valid.json.temporaryPassword.length >= 20);
  const [bad] = validator({ first: () => ({ json: { body: { version: 1, deliveryId: id, login: 'work@example.test', temporaryPassword: 'synthetic-long-enough-password', workEmail: 'work@example.test', personalEmail: 'home@example.test', recipients: ['work@example.test', 'manager@example.test'] } } }) });
  assert.equal(bad.json.valid, false);
  const send = workflow.nodes.find((node) => node.type === 'n8n-nodes-base.microsoftOutlook');
  assert.equal(send.parameters.toRecipients, '={{ $json.actualRecipient }}');
  assert.equal(send.parameters.additionalFields.saveToSentItems, false);
  assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
  assert.equal(workflow.settings.saveDataErrorExecution, 'none');
  assert.equal(workflow.settings.saveExecutionProgress, false);
});
