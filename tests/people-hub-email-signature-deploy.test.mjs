import assert from 'node:assert/strict';
import test from 'node:test';
import { changeFooter, digest, inspect, publish, targets } from '../scripts/deploy-people-hub-email-signature.mjs';
import { HR_EMAIL_SIGNATURE_HTML } from '../scripts/hr-email-signature.mjs';

const oldHR = changeFooter(HR_EMAIL_SIGNATURE_HTML, 'html', true);
const aiRow = 'P: 03 9350 4400<br>E: <a href="mailto:ai@mobilityaccess.com.au" style="color:#68645d">ai@mobilityaccess.com.au</a>';
const credential = `const template = ${JSON.stringify(`<p>Login: starter@example.com</p><table><td>${aiRow}<br>W: mobilityaccess.com.au</td></table>`)};`;
const fields = [
  { node: 'Send', field: 'bodyContent', kind: 'expression', source: `={{ String($json.emailHtml ?? '') + ${JSON.stringify(oldHR)} }}` },
  { node: 'Build HR', field: 'jsCode', kind: 'html', source: `<p>Approved body and office contact</p>${oldHR}` },
  { node: 'Build Credentials', field: 'jsCode', kind: 'credential', source: credential },
];
function fixture() {
  const workflow = { id: 'synthetic', name: 'Synthetic People Hub', active: true, versionId: 'before', activeVersionId: 'before',
    nodes: fields.map((field) => ({ name: field.node, type: field.node === 'Send' ? 'n8n-nodes-base.microsoftOutlook' : 'n8n-nodes-base.code',
      parameters: { [field.field]: field.source, ...(field.node === 'Send' ? { resource: 'message', operation: 'send', toRecipients: 'synthetic@example.com', additionalFields: { bodyContentType: 'html' } } : {}) },
      credentials: { microsoftOutlookOAuth2Api: { id: 'existing-synthetic-credential' } } })),
    connections: { 'Build HR': { main: [[{ node: 'Send', type: 'main', index: 0 }]] } }, settings: { saveDataSuccessExecution: 'none', saveDataErrorExecution: 'none' },
    staticData: { global: { receipts: { 'synthetic-receipt': { state: 'sent', at: 1 } } } } };
  const target = { id: workflow.id, name: workflow.name, version: workflow.versionId, sendCount: 1,
    baselineHash: digest({ name: workflow.name, nodes: workflow.nodes, connections: workflow.connections, settings: workflow.settings }),
    fields: fields.map(({ node, field, kind, source }) => ({ node, field, kind, beforeHash: digest(source), afterHash: digest(changeFooter(source, kind)) })) };
  return { workflow, target };
}
function mock(workflow, mutate = () => {}) {
  let live = structuredClone(workflow);
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body: structuredClone(body) });
    if (method === 'PUT') {
      live = { ...live, ...structuredClone(body), versionId: 'candidate' };
      live.activeVersionId = live.versionId;
    }
    mutate({ method, calls, live });
    return structuredClone(live);
  };
  return { api, calls };
}

test('all seven current People Hub email workflows and eighteen signature sources are pinned', () => {
  assert.equal(new Set(targets.map((target) => target.id)).size, 7);
  assert.equal(targets.reduce((sum, target) => sum + target.sendCount, 0), 18);
  assert.equal(targets.reduce((sum, target) => sum + target.fields.length, 0), 18);
  for (const target of targets) assert.match(target.baselineHash, /^[0-9a-f]{64}$/);
});

test('only the signature mailbox is removed; login email, body, logo and office contact remain', () => {
  for (const field of fields) {
    const updated = changeFooter(field.source, field.kind);
    assert.doesNotMatch(updated, /mailto:|(?:hr|ai)@mobilityaccess\.com\.au/);
    assert.equal(changeFooter(updated, field.kind, true), field.source);
    if (field.kind === 'credential') {
      assert.match(updated, /starter@example\.com/);
      assert.match(updated, /P: 03 9350 4400/);
      assert.match(updated, /W: mobilityaccess\.com\.au/);
    } else assert.match(updated, /mam-logo\.jpg/);
  }
  assert.throws(() => changeFooter(`${oldHR}${oldHR}`, 'html'), /one exact/);
  assert.throws(() => changeFooter('no footer', 'html'), /one exact/);
});

test('inspection preserves routing, graph, settings and receipt state and accepts exact published result', () => {
  const { workflow, target } = fixture();
  const plan = inspect(workflow, target);
  assert.equal(plan.state, 'pending');
  assert.equal('staticData' in plan.payload, false);
  assert.deepEqual(plan.payload.connections, workflow.connections);
  assert.deepEqual(plan.payload.settings, workflow.settings);
  assert.equal(plan.payload.nodes[0].parameters.toRecipients, 'synthetic@example.com');
  assert.deepEqual(plan.payload.nodes[0].credentials, workflow.nodes[0].credentials);
  const published = { ...workflow, ...plan.payload, versionId: 'candidate', activeVersionId: 'candidate' };
  assert.equal(inspect(published, target).state, 'published');
  assert.deepEqual(workflow.staticData.global.receipts, { 'synthetic-receipt': { state: 'sent', at: 1 } });
});

test('unreviewed versions, drafts, recipients, credentials, graph, settings or template changes are rejected', () => {
  const { workflow, target } = fixture();
  const mutations = [
    (w) => { w.id = 'other'; }, (w) => { w.active = false; },
    (w) => { w.versionId = w.activeVersionId = 'unreviewed'; }, (w) => { w.versionId = 'unpublished-draft'; },
    (w) => { w.nodes[0].parameters.toRecipients = 'other@example.com'; },
    (w) => { w.nodes[0].credentials.microsoftOutlookOAuth2Api.id = 'other'; },
    (w) => { w.connections = {}; }, (w) => { w.settings.saveDataSuccessExecution = 'all'; },
    (w) => { w.nodes[1].parameters.jsCode += 'unrelated'; },
    (w) => { w.nodes[1].parameters.jsCode = changeFooter(w.nodes[1].parameters.jsCode, 'html'); },
  ];
  for (const mutate of mutations) { const changed = structuredClone(workflow); mutate(changed); assert.throws(() => inspect(changed, target)); }
});

test('publication binds the automatic update version and omits receipt data from every write', async () => {
  const { workflow, target } = fixture();
  const state = mock(workflow);
  const result = await publish(state.api, target, workflow, inspect(workflow, target));
  assert.equal(result.published, true);
  assert.equal(result.versionId, 'candidate');
  assert.deepEqual(state.calls.map((call) => call.method), ['GET', 'PUT', 'GET']);
  assert.equal(state.calls[1].path, 'workflows/synthetic');
  assert.equal('staticData' in state.calls[1].body, false);
});

test('concurrent edits stop before a write', async () => {
  const { workflow, target } = fixture();
  const state = mock(workflow, ({ live }) => { live.nodes[0].parameters.toRecipients = 'concurrent@example.com'; });
  await assert.rejects(publish(state.api, target, workflow, inspect(workflow, target)), /changed since/);
  assert.deepEqual(state.calls.map((call) => call.method), ['GET']);
});

test('published payload, receipt state and version drift fail verification', async () => {
  for (const stage of ['payload', 'receipt', 'version', 'inactive']) {
    const { workflow, target } = fixture();
    const state = mock(workflow, ({ method, live, calls }) => {
      if (method === 'GET' && calls.length === 3) {
        if (stage === 'receipt') live.staticData.global.receipts = {};
        else if (stage === 'version') live.activeVersionId = 'unpublished';
        else if (stage === 'inactive') live.active = false;
        else live.nodes[0].parameters.toRecipients = 'drift@example.com';
      }
    });
    await assert.rejects(publish(state.api, target, workflow, inspect(workflow, target)), /readback mismatch/);
    assert.deepEqual(state.calls.map((call) => call.method), ['GET', 'PUT', 'GET']);
  }
});

test('unknown PUT failures are never retried and already-published signatures cause no write', async () => {
  const { workflow, target } = fixture();
  const methods = [];
  const api = async (method) => { methods.push(method); if (method === 'PUT') throw new Error('transport unknown'); return workflow; };
  await assert.rejects(publish(api, target, workflow, inspect(workflow, target)), /transport unknown/);
  assert.deepEqual(methods, ['GET', 'PUT']);
  const updated = { ...workflow, ...inspect(workflow, target).payload, versionId: 'candidate', activeVersionId: 'candidate' };
  const state = mock(updated);
  assert.equal((await publish(state.api, target, updated, inspect(updated, target))).alreadyApplied, true);
  assert.deepEqual(state.calls.map((call) => call.method), ['GET']);
});
