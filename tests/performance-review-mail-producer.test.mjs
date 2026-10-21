import assert from 'node:assert/strict';
import test from 'node:test';
import { payload } from './performance-review-n8n-fixtures.mjs';
import { executeGraph } from './performance-review-n8n-runner.mjs';
import { buildMailWorkflow, loadHttpProducer } from './helpers/performance-review-http-producer.mjs';

const workflow = buildMailWorkflow();
const send = workflow.nodes.find(n => n.name === 'Send Word to Manager');
const execute = loadHttpProducer();
test('AM-02 actual installed text fullResponse producer reaches real classifier and finish acknowledgement', async () => {
  const p = payload(); let produced; const names = [];
  const result = await executeGraph(workflow, 'Receive Finalisation', { body: p }, async (node, body) => {
    names.push(node.name);
    if (node.name === 'Begin Delivery') return { statusCode: 200, body: { ok: true, allowed: true } };
    if (node.name === 'Send Word to Manager') {
      produced = await execute(node, { statusCode: 202, headers: {}, statusMessage: 'Accepted', body: '' }, body);
      return produced;
    }
    assert.equal(node.name, 'Finish Delivery'); assert.equal(body.outcome, 'provider_accepted');
    return { statusCode: 200, body: { ok: true, recorded: true } };
  });
  assert.equal(produced.body, ''); assert.equal(Object.hasOwn(produced, 'data'), false);
  assert.deepEqual(names, ['Begin Delivery','Send Word to Manager','Finish Delivery']);
  assert.equal(result.value.status, 'provider_accepted'); assert.equal(result.value.attachmentSha256, p.attachment.sha256);
  assert.deepEqual(result.value.actualRecipients, [p.recipient]);
});

test('AM-02 captured producer default demonstrably returns data instead of body', async () => {
  const predecessor = structuredClone(send);
  delete predecessor.parameters.options.response.response.outputPropertyName;
  const output = await execute(predecessor, { statusCode: 202, headers: {}, statusMessage: 'Accepted', body: '' }, { synthetic: true });
  assert.equal(output.data, ''); assert.equal(Object.hasOwn(output, 'body'), false);
});

test('AM-02 installed producer preserves strict 202 empty-body classification and fixed no-retry send', async () => {
  const outcomes = [
    [202, '', 'provider_accepted'], [202, ' ', 'unknown'], [202, {}, 'unknown'], [202, null, 'unknown'],
    [200, '', 'unknown'], [201, '', 'unknown'], [302, '', 'unknown'], [400, '', 'rejected'], [429, '', 'rejected'], [503, '', 'unknown'], ['202', '', 'unknown'],
  ];
  assert.equal(send.retryOnFail, false); assert.equal(send.parameters.options.redirect.redirect.followRedirects, false);
  assert.equal(send.parameters.options.response.response.fullResponse, true);
  assert.equal(send.parameters.options.response.response.responseFormat, 'text');
  for (const [statusCode, body, expected] of outcomes) {
    const p = payload(); let sends = 0;
    const result = await executeGraph(workflow, 'Receive Finalisation', { body: p }, async (node, requestBody) => {
      if (node.name === 'Begin Delivery') return { statusCode: 200, body: { ok: true, allowed: true } };
      if (node.name === 'Send Word to Manager') {
        sends++;
        assert.deepEqual(requestBody.message.toRecipients, [{ emailAddress: { address: 'manager@mobilityaccess.com.au' } }]);
        assert.deepEqual(requestBody.message.ccRecipients, []); assert.deepEqual(requestBody.message.bccRecipients, []);
        assert.equal(requestBody.message.attachments[0].contentBytes, p.attachment.contentBase64);
        return execute(node, { statusCode, headers: {}, statusMessage: 'Synthetic', body }, requestBody);
      }
      assert.equal(node.name, 'Finish Delivery');
      return { statusCode: 200, body: { ok: true, recorded: true } };
    });
    assert.equal(sends, 1);
    assert.equal(result.outputs['Classify Send'].outcome, expected, JSON.stringify([statusCode, body]));
    assert.equal(result.value.ok, expected === 'provider_accepted');
    assert.equal(result.value.attachmentSha256, p.attachment.sha256);
  }
});
