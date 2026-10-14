import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { buildSubscriptionRequestTemplateMailWorkflow } from '../scripts/build-subscription-request-template-mail-workflow.mjs';
import { loadModule } from './helpers/contact-lifetime-harness.mjs';

const workflow = buildSubscriptionRequestTemplateMailWorkflow({ outlookCredential: { id: 'synthetic-ai-outlook', name: 'Synthetic AI Outlook' } });
const run = (name, input, context = {}) => vm.runInNewContext('(function(){' + workflow.nodes.find(n => n.name === name).parameters.jsCode + '})()', {
  $input: { first: () => ({ json: input }) }, $: name => ({ first: () => ({ json: context[name] }) }), $json: input, Intl, URL,
})[0].json;
const fixture = {
  version: 3, event: 'subscription-request-submitted', deliveryId: 'subscription-request:b1000000-0000-4000-8000-000000000001:2',
  applicantName: 'Synthetic Applicant', applicantWorkEmail: 'applicant@example.test', approverWorkEmail: 'penny@example.test',
  request: { formVersion: 3, service: 'Example <script>service</script>', plan: 'Team', purpose: 'Work & collaboration', company: 'mam',
    duration: 'ongoing', billing: 'annual', currency: 'AUD', quoteCents: 25000, audEstimateCents: 25000, noQuoteReason: null,
    intendedUsers: 'Project team', monthlyCostCents: 3000, annualCostCents: 25000, comparisonUnavailableReason: null,
    payment: 'invoice', cardLabel: null, cardHolder: null, websiteUrl: 'https://example.test/product?team=mam&plan=work',
    category: 'software_app', usageFrequency: 'Daily', oneOffCostCents: 5000, invoiceEmail: 'billing@example.test', invoiceContact: 'Synthetic <contact>' },
};
const validate = f => run('Validate Subscription Request', { body: f });

test('V3 request approval mail preserves all submitted template fields and separate recurring/setup prices', () => {
  const valid = validate(fixture); assert.equal(valid.valid, true); assert.equal(valid.actualRecipient, fixture.approverWorkEmail); assert.equal(valid.ccRecipients, fixture.applicantWorkEmail);
  const mail = run('Build Subscription Email', valid);
  for (const expression of [/Website:<\/strong> https:\/\/example\.test\/product\?team=mam&amp;plan=work/, /Category:<\/strong> Software\/App/, /Usage frequency:<\/strong> Daily/, /Monthly cost:<\/strong> \$30\.00/, /Annual cost:<\/strong> \$250\.00/, /Selected recurring cost:<\/strong> \$250\.00/, /One-off cost:<\/strong> \$50\.00/, /Payment method:<\/strong> Invoice/, /Invoice email:<\/strong> billing@example\.test/, /Invoice contact:<\/strong> Synthetic &lt;contact&gt;/, /view=people&amp;tab=tasks/, /background:#ef6c24/, /mam-logo\.jpg/, /&lt;script&gt;/]) assert.match(mail.bodyContent, expression);
  assert.match(mail.subject, /Subscription approval requested/); assert.match(mail.bodyContent, /awaiting your approval/); assert.doesNotMatch(mail.bodyContent, /<script>|task is due|marketing@|Credit card:/);
  const hook = workflow.nodes.find(n => n.type === 'n8n-nodes-base.webhook'); assert.equal(hook.parameters.path, 'mam-subscription-request-mail-v3'); assert.equal(hook.parameters.authentication, 'headerAuth'); assert.match(hook.webhookId, /^e5170000-/);
  assert.equal(workflow.nodes.length, 14); assert.ok(workflow.nodes.every(n => n.type !== 'n8n-nodes-base.scheduleTrigger'));
  const send = workflow.nodes.find(n => n.type === 'n8n-nodes-base.microsoftOutlook'); assert.equal(send.parameters.toRecipients, '={{ $json.actualRecipient }}'); assert.equal(send.credentials.microsoftOutlookOAuth2Api.id, 'synthetic-ai-outlook'); assert.equal(send.retryOnFail, undefined);
});

test('standalone one-off services and company-card/direct-debit payments render without invented monthly comparisons', () => {
  const request = { ...fixture.request, category: 'one_off_service', billing: 'one_off', monthlyCostCents: null, annualCostCents: null, quoteCents: 5000, audEstimateCents: 5000, payment: 'direct_debit', invoiceEmail: null, invoiceContact: null };
  const valid = validate({ ...fixture, request }); assert.equal(valid.valid, true);
  const mail = run('Build Subscription Email', valid); assert.match(mail.bodyContent, /Category:<\/strong> One-off service/); assert.match(mail.bodyContent, /One-off cost:<\/strong> \$50\.00/); assert.match(mail.bodyContent, /Payment method:<\/strong> Direct debit/); assert.doesNotMatch(mail.bodyContent, /Monthly cost:|Annual cost:|Selected recurring cost:|Invoice contact:/);
  const card = validate({ ...fixture, applicantWorkEmail: fixture.approverWorkEmail, request: { ...fixture.request, payment: 'card', cardLabel: 'Synthetic card', cardHolder: 'Synthetic holder', invoiceEmail: null, invoiceContact: null } }); assert.equal(card.valid, true); assert.equal(card.ccRecipients, '');
  assert.match(run('Build Subscription Email', card).bodyContent, /Credit card:<\/strong> Synthetic card/);
});

test('V3 receiver fails closed on private fields, contact injection, unsafe URLs and inconsistent one-off/recurring quotes', () => {
  const altered = [
    { ...fixture, version: 2 }, { ...fixture, to: 'other@example.test' },
    { ...fixture, applicantWorkEmail: 'applicant@example.test\r\nBcc:other@example.test' },
    { ...fixture, approverWorkEmail: 'penny@example.test,other@example.test' },
    ...[
      { formVersion: 2 }, { password: 'synthetic' }, { websiteUrl: 'javascript:alert(1)' }, { websiteUrl: 'https://synthetic:secret@example.test' },
      { websiteUrl: 'https://example.test/\npath' }, { websiteUrl: 'https://example.test/' + 'a'.repeat(2048) },
      { invoiceEmail: 'billing@example.test;other@example.test' }, { invoiceEmail: ' Billing@example.test' }, { invoiceContact: 'a'.repeat(161) },
      { category: null }, { category: 'unknown' }, { payment: 'non_card' }, { payment: 'card', cardLabel: null },
      { quoteCents: 3000 }, { oneOffCostCents: -1 }, { oneOffCostCents: 100000001 }, { oneOffCostCents: 1.2 },
      { monthlyCostCents: null }, { category: 'one_off_service' }, { billing: 'one_off' }, { currency: 'USD' },
    ].map(change => ({ ...fixture, request: { ...fixture.request, ...change } })),
  ];
  for (const f of altered) assert.equal(validate(f).valid, false);
  assert.equal(validate({ ...fixture, request: { ...fixture.request, monthlyCostCents: null, comparisonUnavailableReason: 'Only annual pricing is published', websiteUrl: null, usageFrequency: null, invoiceEmail: null, invoiceContact: null } }).valid, true);
  const oneOff = { ...fixture.request, category: 'hardware', billing: 'one_off', monthlyCostCents: null, annualCostCents: null, quoteCents: 5000, audEstimateCents: 5000 };
  assert.equal(validate({ ...fixture, request: oneOff }).valid, true);
  for (const change of [{ monthlyCostCents: 3000 }, { oneOffCostCents: 0, quoteCents: 0, audEstimateCents: 0 }, { oneOffCostCents: null }]) assert.equal(validate({ ...fixture, request: { ...oneOff, ...change } }).valid, false);
});

test('V3 receiver still needs matching live reservation and exact canonical To/CC confirmation', () => {
  const valid = validate(fixture), context = { 'Validate Subscription Request': valid };
  const reservation = { outcome: 'send', eventKey: fixture.deliveryId, deliveryToken: 'a1000000-0000-4000-8000-000000000001' };
  assert.equal(run('Gate Subscription Delivery', reservation, context).shouldSend, true);
  assert.equal(run('Gate Subscription Delivery', { ...reservation, eventKey: 'wrong' }, context).shouldSend, false);
  const duplicate = { outcome: 'duplicate', ok: true, alreadySent: true, eventKey: fixture.deliveryId, actualRecipient: fixture.approverWorkEmail, actualCcRecipients: fixture.applicantWorkEmail };
  assert.equal(run('Gate Subscription Delivery', duplicate, context).alreadySent, true);
  assert.equal(run('Gate Subscription Delivery', { ...duplicate, actualRecipient: 'other@example.test' }, context).alreadySent, false);
  const mail = run('Build Subscription Email', valid), confirmation = { ok: true, sent: true, eventKey: fixture.deliveryId, actualRecipient: fixture.approverWorkEmail, actualCcRecipients: fixture.applicantWorkEmail };
  assert.equal(run('Validate Subscription Confirmation', confirmation, { 'Build Subscription Email': mail }).ok, true);
  assert.equal(run('Validate Subscription Confirmation', { ...confirmation, actualCcRecipients: '' }, { 'Build Subscription Email': mail }).ok, false);
  for (const n of workflow.nodes.filter(n => n.type === 'n8n-nodes-base.httpRequest')) { assert.equal(n.parameters.options.redirect.redirect.followRedirects, false); assert.equal(n.retryOnFail, undefined); }
});

test('worker keeps legacy envelopes on V2, routes V3 separately and never finishes an unsupported payload', async () => {
  const originalFetch = globalThis.fetch, origin = process.env.MAM_N8N_LEAVE_WEBHOOK_ORIGIN, secret = process.env.MAM_N8N_LEAVE_WEBHOOK_SECRET;
  process.env.MAM_N8N_LEAVE_WEBHOOK_ORIGIN = 'https://n8n.example.test'; process.env.MAM_N8N_LEAVE_WEBHOOK_SECRET = 'synthetic-subscription-mail-secret';
  try {
    const legacyRequest = { ...fixture.request, formVersion: 2, payment: 'card', cardLabel: 'Synthetic card', cardHolder: 'Synthetic holder' };
    for (const field of ['websiteUrl', 'category', 'usageFrequency', 'oneOffCostCents', 'invoiceEmail', 'invoiceContact']) delete legacyRequest[field];
    const payloads = [{ ...fixture, version: 2, request: legacyRequest }, fixture, { ...fixture, version: 4 }]; let fetches = 0; const finished = [];
    const admin = { rpc: async (name, args) => name === 'claim_subscription_request_mail' ? { data: payloads.map((payload, i) => ({ request_id: 'synthetic-request-' + i, version: i + 1, claim_token: 'synthetic-token-' + i, payload })), error: null } : (finished.push(args.p_request_id), { data: true, error: null }) };
    globalThis.fetch = async (url, options) => { const payload = JSON.parse(options.body); fetches++; assert.equal(url.pathname, payload.version === 2 ? '/webhook/mam-subscription-request-mail-v2' : '/webhook/mam-subscription-request-mail-v3'); assert.equal(options.redirect, 'error'); return { ok: true, json: async () => ({ ok: true, sent: true, deliveryId: payload.deliveryId, actualRecipient: payload.approverWorkEmail, actualCcRecipients: payload.applicantWorkEmail }) }; };
    const worker = loadModule('src/lib/subscription-request-mail.ts', { '@/lib/supabase/admin': { createAdminClient: () => admin } });
    const result = await worker.dispatchSubscriptionRequestMail(); assert.equal(result.claimed, 3); assert.equal(result.sent, 2); assert.equal(result.ok, false); assert.equal(fetches, 2); assert.deepEqual(finished, ['synthetic-request-0', 'synthetic-request-1']);
  } finally { globalThis.fetch = originalFetch; if (origin === undefined) delete process.env.MAM_N8N_LEAVE_WEBHOOK_ORIGIN; else process.env.MAM_N8N_LEAVE_WEBHOOK_ORIGIN = origin; if (secret === undefined) delete process.env.MAM_N8N_LEAVE_WEBHOOK_SECRET; else process.env.MAM_N8N_LEAVE_WEBHOOK_SECRET = secret; }
});
