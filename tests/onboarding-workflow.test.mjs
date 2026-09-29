import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOnboardingCredentialWorkflow } from '../scripts/build-onboarding-credential-workflow.mjs';

test('live workflow requires bound header credential and durable reservation before Outlook, with provider confirmation afterwards', () => {
  assert.throws(() => buildOnboardingCredentialWorkflow(), /webhook credential/i);
  const flow = buildOnboardingCredentialWorkflow({ webhookCredential: { id: 'synthetic', name: 'Synthetic Header' } });
  const edge = (from) => flow.connections[from]?.main?.flat().map(e => e.node) ?? [];
  assert.ok(edge('Valid Credential Request?').includes('Reserve Credential Delivery'));
  assert.ok(edge('Reserve Credential Delivery').includes('Gate Credential Reservation'));
  assert.ok(edge('Send Credential Email from HR').includes('Build Provider Receipt'));
  assert.ok(edge('Build Provider Receipt').includes('Confirm Credential Delivery'));
  assert.ok(!edge('Send Credential Email from HR').includes('Acknowledge Credential Email'));
  const receiptCode = new Function('$input', '$', flow.nodes.find(n => n.name === 'Build Provider Receipt').parameters.jsCode);
  const context = { deliveryId: '10000000-0000-4000-8000-000000000004', actualRecipient: 'work@example.test', deliveryToken: '20000000-0000-4000-8000-000000000001' };
  const $ = () => ({ first: () => ({ json: context }) });
  assert.throws(() => receiptCode({ first: () => ({ json: {} }) }, $), /Provider identity unavailable/);
  assert.equal(receiptCode({ first: () => ({ json: { id: 'synthetic-provider-id' } }) }, $)[0].json.providerReceipt.messageId, 'synthetic-provider-id');
  const gate = new Function('$input', '$', flow.nodes.find(n => n.name === 'Gate Credential Reservation').parameters.jsCode);
  const gateContext = { ...context, temporaryPassword: 'synthetic-long-enough-password' };
  const gateLookup = () => ({ first: () => ({ json: gateContext }) });
  for (const reservation of [{ outcome: 'rejected' }, { outcome: 'send', deliveryToken: context.deliveryToken, eventKey: 'other' },
    { outcome: 'send', deliveryToken: 'bad', eventKey: 'onboarding-credential:' + context.deliveryId }]) {
    const result = gate({ first: () => ({ json: reservation }) }, gateLookup)[0].json;
    assert.equal(result.shouldSend, false);
    assert.ok(!JSON.stringify(result).includes(gateContext.temporaryPassword));
  }
  assert.equal(gate({ first: () => ({ json: { outcome: 'send', deliveryToken: context.deliveryToken, eventKey: 'onboarding-credential:' + context.deliveryId } }) }, gateLookup)[0].json.shouldSend, true);
  assert.equal(flow.nodes.find(n => n.name === 'Receive Credential Request').credentials.httpHeaderAuth.id, 'synthetic');
});

test('credential workflow validates employee-only recipients and never includes manager', () => {
  const workflow = buildOnboardingCredentialWorkflow({ webhookCredential: { id: 'synthetic', name: 'Synthetic Header' } });
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
