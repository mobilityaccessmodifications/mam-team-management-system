import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { payload } from './performance-review-n8n-fixtures.mjs';
import { executeGraph } from './performance-review-n8n-runner.mjs';
const require = createRequire(import.meta.url);
function code(workflow, name, value, outputs = {}) {
  const n = workflow.nodes.find(n => n.name === name);
  assert.ok(n, `executable Code node exists: ${name}`);
  const fn = new Function('$json', '$input', '$', 'require', n.parameters.jsCode);
  const restrictedRequire = name => { assert.equal(name, 'crypto'); return require('node:crypto'); };
  return fn(value, {all: () => [{json: value}], first: () => ({json: value})}, n => ({first: () => ({json: outputs[n]})}), restrictedRequire)[0].json;
}

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BUILDER = `${ROOT}scripts/build-performance-review-mail-workflow.py`;
function build() {
  assert.ok(existsSync(BUILDER), 'task-owned builder exists');
  const result = spawnSync('/usr/bin/python3', ['-B', BUILDER], {cwd: ROOT, env: {PATH: '/usr/bin:/bin'}, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('dedicated inactive create definition uses authenticated exact business path and no execution persistence', () => {
  const workflow = build();
  assert.equal(workflow.name, 'MAM People Hub - Performance Review Careers Mail (Live)');
  assert.equal(Object.hasOwn(workflow, 'active'), false);
  const trigger = workflow.nodes.find(n => n.name === 'Receive Finalisation');
  assert.equal(trigger.typeVersion, 2.1);
  assert.equal(trigger.parameters.httpMethod, 'POST');
  assert.equal(trigger.parameters.path, 'mam-people-hub-performance-review-mail-v1');
  assert.equal(trigger.parameters.authentication, 'headerAuth');
  assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
  assert.equal(workflow.settings.saveDataErrorExecution, 'none');
  assert.equal(workflow.settings.saveManualExecutions, false);
  assert.equal(workflow.settings.saveExecutionProgress, false);
  assert.ok(workflow.nodes.every(n => n.retryOnFail === false));
});

test('canonical manager Word is unchanged while names and private note are escaped only into email body', () => {
  const p = payload();
  const value = code(build(), 'Validate Payload', {body: p});
  assert.equal(value.valid, true);
  const mail = value.graphBody;
  assert.equal(mail.saveToSentItems, true);
  assert.deepEqual(mail.message.toRecipients, [{emailAddress: {address: 'careers@mobilityaccess.com.au'}}]);
  assert.deepEqual(mail.message.ccRecipients, []);
  assert.deepEqual(mail.message.bccRecipients, []);
  assert.equal(mail.message.body.contentType, 'HTML');
  assert.ok(mail.message.body.content.includes('Synthetic &lt;Employee&gt;'));
  assert.ok(mail.message.body.content.includes('Synthetic &amp; Manager'));
  assert.ok(mail.message.body.content.includes('&lt;script&gt;&quot;&amp;&#39;<br>'));
  const attachment = mail.message.attachments[0];
  assert.equal(attachment['@odata.type'], '#microsoft.graph.fileAttachment');
  assert.equal(attachment.name, p.attachment.fileName);
  assert.equal(attachment.contentType, p.attachment.mimeType);
  assert.equal(attachment.contentBytes, p.attachment.contentBase64);
  const bytes = Buffer.from(attachment.contentBytes, 'base64');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), p.attachment.sha256);
  assert.equal(bytes.includes(Buffer.from('PRIVATE-SYNTHETIC-NOTE')), false);
  assert.deepEqual(value.beginBody, {phase: 'begin', deliveryId: p.deliveryId, claimToken: p.claimToken, attachmentSha256: p.attachment.sha256});
});

test('closed wire schema rejects unsafe recipients identifiers bytes and unrelated salary or calendar fields', () => {
  const workflow = build();
  const mutations = [
    ['extra', p => {p.extra = true;}], ['calendar', p => {p.calendarUrl = 'https://synthetic.invalid';}],
    ['salary', p => {p.salary = 123;}], ['recipient', p => {p.recipient = 'synthetic@example.invalid';}],
    ['cc', p => {p.cc = ['careers@mobilityaccess.com.au'];}], ['event', p => {p.event = 'other-event';}],
    ['event key', p => {p.eventKey += ':other';}], ['version type', p => {p.version = '1';}],
    ['uuid case', p => {p.deliveryId = p.deliveryId.toUpperCase();}], ['claim UUID', p => {p.claimToken = 'bad';}],
    ['review UUID', p => {p.reviewId = '../../other';}], ['review code', p => {p.reviewCode = 'PR-2026-900001\r\nother';}],
    ['missing', p => {delete p.employeeName;}], ['name type', p => {p.employeeName = ['x'];}],
    ['empty name', p => {p.employeeName = ' ';}], ['name bound', p => {p.managerName = 'x'.repeat(201);}],
    ['note type', p => {p.managerNote = {};}], ['note bound', p => {p.managerNote = 'x'.repeat(12001);}],
    ['bad date', p => {p.finalisedAt = '2026-02-30T00:00:00.000Z';}], ['date type', p => {p.finalisedAt = 1;}],
    ['attachment extra', p => {p.attachment.url = 'https://synthetic.invalid';}],
    ['filename', p => {p.attachment.fileName = 'other-manager.docx';}], ['extension', p => {p.attachment.fileName = p.reviewCode + '-manager.pdf';}],
    ['mime', p => {p.attachment.mimeType = 'application/pdf';}], ['base64 space', p => {p.attachment.contentBase64 += '\n';}],
    ['base64 bits', p => {p.attachment.contentBase64 = 'Zh=='; p.attachment.sha256 = createHash('sha256').update('f').digest('hex');}],
    ['empty bytes', p => {p.attachment.contentBase64 = '';}], ['hash', p => {p.attachment.sha256 = '0'.repeat(64);}],
    ['hash case', p => {p.attachment.sha256 = p.attachment.sha256.toUpperCase();}],
    ['oversize', p => {const bytes = Buffer.alloc(2 * 1024 * 1024 + 1); p.attachment.contentBase64 = bytes.toString('base64'); p.attachment.sha256 = createHash('sha256').update(bytes).digest('hex');}],
    ['symbol', p => {p[Symbol('extra')] = true;}], ['accessor', p => {Object.defineProperty(p, 'employeeName', {get() {throw Error('must not invoke getter');}, enumerable: true});}],
  ];
  for (const [label, mutate] of mutations) {
    const p = payload(); mutate(p);
    const result = code(workflow, 'Validate Payload', {body: p});
    assert.equal(result.valid, false, label);
    assert.equal(Object.hasOwn(result, 'graphBody'), false, label);
    assert.equal(Object.hasOwn(result, 'beginBody'), false, label);
  }
  for (const p of [null, [], 'payload', true]) assert.equal(code(workflow, 'Validate Payload', {body: p}).valid, false);
  const boundary = payload(); const bytes = Buffer.alloc(2 * 1024 * 1024);
  boundary.attachment.contentBase64 = bytes.toString('base64'); boundary.attachment.sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(code(workflow, 'Validate Payload', {body: boundary}).valid, true);
});

test('only a strict literal allowed true from the closed begin acknowledgement reaches one Graph send', async () => {
  const workflow = build(); const p = payload();
  const beginResults = [
    {statusCode: 200, body: {ok: true, allowed: true}},
    ...[false, null, 'true', 1, {}, [true]].map(allowed => ({statusCode: 200, body: {ok: true, allowed}})),
    {statusCode: 200, body: {ok: true, allowed: true, extra: true}},
    {statusCode: 200, body: {ok: true, permit: true}},
    {statusCode: 500, body: {ok: true, allowed: true}},
    {statusCode: 307, body: {ok: true, allowed: true}}, {error: 'timeout'},
  ];
  for (const [index, begin] of beginResults.entries()) {
    const calls = [];
    const result = await executeGraph(workflow, 'Receive Finalisation', {body: p}, async (n, body) => {
      calls.push([n.name, body]);
      if (n.name === 'Begin Delivery') return begin;
      if (n.name === 'Finish Delivery') return {statusCode: 200, body: {ok: true, recorded: true}};
      assert.equal(n.name, 'Send Word to Careers'); return {statusCode: 202, body: ''};
    });
    assert.deepEqual(calls[0], ['Begin Delivery', {phase: 'begin', deliveryId: p.deliveryId, claimToken: p.claimToken, attachmentSha256: p.attachment.sha256}]);
    assert.equal(calls.filter(([name]) => name === 'Send Word to Careers').length, index === 0 ? 1 : 0);
    if (index > 0) assert.deepEqual(result.value, {ok: false, status: 'held', deliveryId: p.deliveryId, eventKey: p.eventKey, actualRecipients: ['careers@mobilityaccess.com.au'], attachmentSha256: p.attachment.sha256});
  }
  const invalid = payload(); invalid.recipient = 'synthetic@example.invalid'; let calls = 0;
  const result = await executeGraph(workflow, 'Receive Finalisation', {body: invalid}, async () => {calls++; throw Error('unexpected');});
  assert.equal(calls, 0); assert.equal(result.value.status, 'held');
});

test('empty Graph 202 is accepted only after exact finish acknowledgement and never claims inbox delivery', async () => {
  const workflow = build(); const p = payload();
  const outcomes = [
    [{statusCode: 202, body: ''}, 'provider_accepted'],
    [{statusCode: 202, body: {id: 'synthetic-message-id'}}, 'unknown'],
    [{statusCode: 200, body: ''}, 'unknown'], [{statusCode: 400, body: 'rejected'}, 'rejected'],
    [{statusCode: 403, body: ''}, 'rejected'], [{statusCode: 429, body: ''}, 'rejected'],
    [{statusCode: 503, body: ''}, 'unknown'], [{statusCode: 302, body: ''}, 'unknown'], [null, 'unknown'],
  ];
  const finishes = [{statusCode: 200, body: {ok: true, recorded: true}},
    ...[false, null, 'true', 1, [true], {}].map(recorded => ({statusCode: 200, body: {ok: true, recorded}})),
    {statusCode: 200, body: {ok: true, recorded: true, extra: true}}, {statusCode: 500, body: {ok: true, recorded: true}}, null];
  for (const [provider, outcome] of outcomes) for (const [index, finish] of finishes.entries()) {
    const calls = [];
    const result = await executeGraph(workflow, 'Receive Finalisation', {body: p}, async (n, body) => {
      calls.push([n.name, body]);
      if (n.name === 'Begin Delivery') return {statusCode: 200, body: {ok: true, allowed: true}};
      if (n.name === 'Send Word to Careers') {if (provider === null) throw Error('timeout'); return provider;}
      assert.equal(n.name, 'Finish Delivery'); if (finish === null) throw Error('finish timeout'); return finish;
    });
    assert.deepEqual(calls.map(([name]) => name), ['Begin Delivery', 'Send Word to Careers', 'Finish Delivery']);
    assert.deepEqual(calls[2][1], {phase: 'finish', deliveryId: p.deliveryId, claimToken: p.claimToken, attachmentSha256: p.attachment.sha256, outcome});
    const accepted = outcome === 'provider_accepted' && index === 0;
    assert.deepEqual(result.value, {ok: accepted, status: accepted ? 'provider_accepted' : 'held', deliveryId: p.deliveryId, eventKey: p.eventKey, actualRecipients: ['careers@mobilityaccess.com.au'], attachmentSha256: p.attachment.sha256});
    assert.equal(Object.hasOwn(result.value, 'messageId'), false);
  }
});

test('concurrent begin CAS loser duplicate and late callback cannot dispatch another mail', async () => {
  const workflow = build(); const p = payload(); let begun = false; let sends = 0; let finishes = 0;
  const http = async n => {
    if (n.name === 'Begin Delivery') {const allowed = !begun; begun = true; return {statusCode: 200, body: {ok: true, allowed}};}
    if (n.name === 'Send Word to Careers') {sends++; return {statusCode: 202, body: ''};}
    finishes++; assert.equal(n.name, 'Finish Delivery'); return {statusCode: 200, body: {ok: true, recorded: true}};
  };
  const two = await Promise.all([executeGraph(workflow, 'Receive Finalisation', {body: p}, http), executeGraph(workflow, 'Receive Finalisation', {body: p}, http)]);
  assert.equal(two.filter(r => r.value.status === 'provider_accepted').length, 1);
  assert.equal(two.filter(r => r.value.status === 'held').length, 1);
  assert.equal((await executeGraph(workflow, 'Receive Finalisation', {body: p}, http)).value.status, 'held');
  assert.equal(sends, 1); assert.equal(finishes, 1);
});

test('readiness is authenticated and disjoint from begin finish and every Graph send', async () => {
  const workflow = build();
  const ready = workflow.nodes.find(n => n.name === 'Receive Readiness');
  assert.ok(ready, 'separate no-send readiness trigger exists');
  assert.equal(ready.parameters.httpMethod, 'GET');
  assert.equal(ready.parameters.path, 'mam-people-hub-performance-review-mail-v1-ready');
  assert.equal(ready.parameters.authentication, 'headerAuth');
  for (const b of [{ok: true, ready: true}, {ok: true, ready: 'true'}, {ok: true, ready: true, extra: true}]) {
    const calls = [];
    const result = await executeGraph(workflow, 'Receive Readiness', {}, async (n, body) => {
      calls.push([n.name, body]); assert.equal(n.parameters.url, 'https://mam-team-management-system-ten.vercel.app/api/performance-reviews/mail');
      return {statusCode: 200, body: b};
    });
    assert.deepEqual(calls, [['Hub Readiness', {phase: 'readiness'}]]);
    assert.deepEqual(result.value, b.ready === true && !Object.hasOwn(b, 'extra') ? {ok: true, ready: true} : {ok: false, ready: false});
    assert.equal(result.entered.includes('Send Word to Careers'), false);
  }
});

test('one new five minute scheduler dispatches only the new fixed Hub GET route with no HTTP redirects or retries', async () => {
  const workflow = build(); const schedule = workflow.nodes.find(n => n.name === 'Every Five Minutes');
  assert.ok(schedule, 'dedicated scheduler exists');
  assert.deepEqual(schedule.parameters.rule, {interval: [{field: 'minutes', minutesInterval: 5}]});
  assert.equal(schedule.typeVersion, 1.2);
  let calls = 0;
  const result = await executeGraph(workflow, 'Every Five Minutes', {}, async (n, body) => {
    calls++; assert.equal(n.name, 'Dispatch New Performance Queue'); assert.equal(n.parameters.method, 'GET');
    assert.equal(n.parameters.url, 'https://mam-team-management-system-ten.vercel.app/api/performance-reviews/mail');
    assert.equal(body, undefined); assert.equal(n.parameters.genericAuthType, 'httpHeaderAuth');
    assert.ok(n.credentials.httpHeaderAuth.id.includes('PARENT_CRON'));
    return {statusCode: 200, body: {ok: true}};
  });
  assert.equal(calls, 1); assert.equal(result.entered.includes('Send Word to Careers'), false);
  for (const n of workflow.nodes.filter(n => n.type === 'n8n-nodes-base.httpRequest')) {
    assert.equal(n.retryOnFail, false); assert.equal(n.parameters.options.redirect.redirect.followRedirects, false);
    assert.ok(n.parameters.options.timeout > 0 && n.parameters.options.timeout <= 20000);
    assert.equal(n.parameters.options.response.response.fullResponse, true);
  }
  const send = workflow.nodes.find(n => n.name === 'Send Word to Careers');
  assert.equal(send.parameters.authentication, 'predefinedCredentialType');
  assert.equal(send.parameters.nodeCredentialType, 'microsoftOutlookOAuth2Api');
  assert.equal(send.parameters.url, 'https://graph.microsoft.com/v1.0/me/sendMail');
});
