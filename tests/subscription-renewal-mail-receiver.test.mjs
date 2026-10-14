import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { buildSubscriptionRenewalMailWorkflow } from '../scripts/build-subscription-renewal-mail-workflow.mjs';

const workflow = buildSubscriptionRenewalMailWorkflow({ outlookCredential: { id: 'synthetic-ai-outlook', name: 'Synthetic AI Outlook' } });
const run = (name, input, context = {}) => vm.runInNewContext('(function(){' + workflow.nodes.find(n => n.name === name).parameters.jsCode + '})()', {
  $input: { first: () => ({ json: input }) }, $: name => ({ first: () => ({ json: context[name] }) }), $json: input, Intl,
})[0].json;
const fixture = { version: 1, event: 'subscription-renewal-reminder', deliveryId: 'subscription-renewal:b1000000-0000-4000-8000-000000000001:2026-10-22:upcoming', serviceName: 'Example <script>service</script>', nextRenewalOn: '2026-10-22', phase: 'upcoming', toRecipients: 'manager@example.test,penny@example.test' };

test('renewal reminder is distinct from quarterly review, uses Calendar and keeps authenticated zero-scheduler receipt graph', () => {
  const valid = run('Validate Subscription Renewal', { body: fixture }); assert.equal(valid.valid, true); assert.equal(valid.actualRecipient, fixture.toRecipients); assert.equal(valid.ccRecipients, '');
  const mail = run('Build Subscription Email', valid); assert.match(mail.subject, /Subscription renewal upcoming:/); assert.match(mail.bodyContent, /Renewal date:<\/strong> 22 Oct 2026/); assert.match(mail.bodyContent, /Upcoming renewal/); assert.match(mail.bodyContent, /view=calendar/); assert.match(mail.bodyContent, /background:#ef6c24/); assert.match(mail.bodyContent, /mam-logo\.jpg/); assert.match(mail.bodyContent, /&lt;script&gt;/); assert.doesNotMatch(mail.bodyContent, /quarterly|mark.*Done|tab=tasks|<script>/);
  const due = run('Validate Subscription Renewal', { body: { ...fixture, phase: 'due', deliveryId: fixture.deliveryId.replace(':upcoming', ':due') } }); assert.equal(due.valid, true); assert.match(run('Build Subscription Email', due).subject, /renewal due:/);
  assert.equal(workflow.nodes.length, 14); assert.ok(workflow.nodes.every(n => n.type !== 'n8n-nodes-base.scheduleTrigger'));
  const hook = workflow.nodes.find(n => n.type === 'n8n-nodes-base.webhook'); assert.equal(hook.parameters.path, 'mam-subscription-renewal-mail-v1'); assert.equal(hook.parameters.authentication, 'headerAuth'); assert.match(hook.webhookId, /^e5180000-/);
  const sender = workflow.nodes.find(n => n.type === 'n8n-nodes-base.microsoftOutlook'); assert.equal(sender.parameters.toRecipients, '={{ $json.actualRecipient }}'); assert.equal(sender.parameters.additionalFields.ccRecipients, '={{ $json.ccRecipients }}'); assert.equal(sender.credentials.microsoftOutlookOAuth2Api.id, 'synthetic-ai-outlook'); assert.equal(sender.retryOnFail, undefined);
});

test('renewal receiver rejects another reminder kind, date/phase drift, invalid dates and recipient injection', () => {
  for (const changed of [{ event: 'subscription-review-reminder' }, { deliveryId: fixture.deliveryId.replace('subscription-renewal:', 'subscription-review:') }, { phase: 'due' }, { nextRenewalOn: '2026-10-23' }, { cc: 'other@example.test' }, { password: 'synthetic' }, { version: 2 }, { toRecipients: 'penny@example.test,manager@example.test' }, { toRecipients: 'penny@example.test,penny@example.test' }, { toRecipients: 'Penny@example.test' }, { toRecipients: 'penny@example.test\r\nBcc:other@example.test' }, { toRecipients: '' }, { toRecipients: 'a@example.test;b@example.test' }, { serviceName: '' }]) assert.equal(run('Validate Subscription Renewal', { body: { ...fixture, ...changed } }).valid, false);
  for (const date of ['2026-02-30', '2026-04-31', '2026-13-01']) assert.equal(run('Validate Subscription Renewal', { body: { ...fixture, nextRenewalOn: date, deliveryId: fixture.deliveryId.replace('2026-10-22', date) } }).valid, false);
});

test('renewal reminder reports success only for its reservation key, canonical recipients and empty CC', () => {
  const valid = run('Validate Subscription Renewal', { body: fixture }), context = { 'Validate Subscription Renewal': valid };
  const reservation = { outcome: 'send', eventKey: fixture.deliveryId, deliveryToken: 'a1000000-0000-4000-8000-000000000001' };
  assert.equal(run('Gate Subscription Delivery', reservation, context).shouldSend, true); assert.equal(run('Gate Subscription Delivery', { ...reservation, eventKey: fixture.deliveryId.replace('subscription-renewal:', 'subscription-review:') }, context).shouldSend, false);
  const duplicate = { outcome: 'duplicate', ok: true, alreadySent: true, eventKey: fixture.deliveryId, actualRecipient: fixture.toRecipients, actualCcRecipients: '' };
  assert.equal(run('Gate Subscription Delivery', duplicate, context).alreadySent, true); assert.equal(run('Gate Subscription Delivery', { ...duplicate, actualCcRecipients: 'other@example.test' }, context).alreadySent, false);
  const mail = run('Build Subscription Email', valid), confirmation = { ok: true, sent: true, eventKey: fixture.deliveryId, actualRecipient: fixture.toRecipients, actualCcRecipients: '' };
  assert.equal(run('Validate Subscription Confirmation', confirmation, { 'Build Subscription Email': mail }).ok, true); assert.equal(run('Validate Subscription Confirmation', { ...confirmation, actualRecipient: 'penny@example.test' }, { 'Build Subscription Email': mail }).ok, false);
  for (const node of workflow.nodes.filter(n => n.type === 'n8n-nodes-base.httpRequest')) { assert.equal(node.parameters.options.redirect.redirect.followRedirects, false); assert.equal(node.retryOnFail, undefined); }
});
