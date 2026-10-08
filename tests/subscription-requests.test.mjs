import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
function load() {
  assert.ok(existsSync('src/lib/subscription-request-types.ts'), 'Request form validation is not implemented');
  const loaded = { exports: {} };
  new Function('module','exports',ts.transpileModule(readFileSync('src/lib/subscription-request-types.ts','utf8'), { compilerOptions: { module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022 } }).outputText)(loaded,loaded.exports);
  return loaded.exports;
}
export const payload = { kind:'new_purchase', service:'Synthetic Service', plan:'Team', purpose:'Synthetic project work', company:'mam', payer:'MAM', duration:'12 months', billing:'annual', currency:'USD', tax:'Exclusive', quoteCents:12000, noQuoteReason:'', audEstimateCents:18000, payment:'card', cardLabel:'Synthetic business card', cardHolder:'Synthetic holder', responsiblePersonId:null, intendedUsers:'Project team' };
test('request submission validates distinct original currency, estimate and payment fields', () => {
  const { validateRequestPayload } = load();
  assert.deepEqual(validateRequestPayload(payload,true),payload);
  assert.throws(()=>validateRequestPayload({...payload,cardHolder:''},true),/card/i);
  assert.throws(()=>validateRequestPayload({...payload,quoteCents:null},true),/quote/i);
  assert.throws(()=>validateRequestPayload({...payload,quoteCents:null,noQuoteReason:'Supplier quote pending',audEstimateCents:null},true),/AUD/i);
  assert.throws(()=>validateRequestPayload({...payload,password:'forbidden'},true),/field/i);
  assert.throws(()=>validateRequestPayload({...payload,quoteCents:-1},true),/amount/i);
  assert.deepEqual(validateRequestPayload({},false),{});
});
