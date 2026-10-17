import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export function buildMailWorkflow() {
  const builder = fileURLToPath(new URL('../../scripts/build-performance-review-mail-workflow.py', import.meta.url));
  const result = spawnSync('/usr/bin/python3', ['-B', builder], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
export function loadHttpProducer(bytes = gunzipSync(readFileSync(new URL('../performance-review-n8n-portable/http-request-v3.fixture.gz', import.meta.url)))) {
  const pin = JSON.parse(readFileSync(new URL('../performance-review-n8n-portable/http-producer-provenance.json', import.meta.url), 'utf8'));
  assert.equal(bytes.length, pin.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.sha256);
  const dependencies = {
    'lodash/set': () => { throw Error('unexpected set'); },
    '@n8n/utils/errors/ensure-error': { ensureError: e => e },
    'n8n-workflow': { NodeConnectionTypes: { Main: 'main' }, NodeOperationError: class extends Error {}, NodeApiError: class extends Error {}, jsonParse: JSON.parse },
    '../../../utils/utilities': { keysToLowercase: o => o },
    './Description': { mainProperties: [] },
    '../GenericFunctions': { setAgentOptions: () => {}, updadeQueryParameterConfig: () => false, getAllowedDomains: () => undefined,
      getOAuth2AdditionalParameters: () => undefined, getSecrets: () => [], sanitizeUiMessage: () => ({}), replaceNullValues: item => item, binaryContentTypes: [] },
    './utils/binaryData': {}, './utils/parse': {}, '../shared/optimizeResponse': { configureResponseOptimizer: () => value => value }, './utils/buffer-decoding': {},
  };
  const mod = { exports: {} };
  new Function('require','module','exports',bytes.toString())(name => {
    assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name];
  }, mod, mod.exports);
  return async function execute(node, terminal, body) {
    let calls = 0;
    const parameters = structuredClone(node.parameters);
    parameters.jsonBody = body;
    const ctx = {
      getNode: () => node, getInputData: () => [{ json: {} }], getMode: () => 'webhook', continueOnFail: () => false, isToolExecution: () => false,
      getNodeParameter: (key, _index, fallback) => key.split('.').reduce((o, k) => o?.[k], parameters) ?? fallback,
      getCredentials: async () => ({}), sendMessageToUI: () => {},
      helpers: { async requestWithAuthentication(credential, options) {
        calls++; assert.equal(credential, 'microsoftOutlookOAuth2Api');
        assert.equal(options.method, 'POST'); assert.equal(options.uri, 'https://graph.microsoft.com/v1.0/me/sendMail');
        assert.equal(options.followRedirect, false); assert.equal(options.followAllRedirects, false);
        assert.deepEqual(options.body, body);
        return structuredClone(terminal);
      } },
    };
    const result = await new mod.exports.HttpRequestV3({}).execute.call(ctx);
    assert.equal(calls, 1);
    assert.equal(result[0].length, 1);
    return result[0][0].json;
  };
}
