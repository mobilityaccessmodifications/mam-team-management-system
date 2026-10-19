import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildMailWorkflow } from './helpers/performance-review-http-producer.mjs';
import { payload } from './performance-review-n8n-fixtures.mjs';
import { fixture, loadMailHarness, ack } from './helpers/performance-review-mail-harness.mjs';

const validateSource = buildMailWorkflow().nodes.find(n => n.name === 'Validate Payload').parameters.jsCode;
function savedValidator(p) {
  return new Function('$json', '$input', 'require', validateSource)({ body: p }, { all: () => [{ json: { body: p } }] }, name => {
    assert.equal(name, 'crypto'); return { createHash };
  })[0].json;
}

test('AM-05 mail wire rejects unsupported C0 controls and DEL in every mail text field', () => {
  const h = loadMailHarness();
  const controls = ['\u000b', ...Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).filter(c => !'\t\n\r'.includes(c)), '\u007f'];
  for (const key of ['managerNote', 'employeeName', 'managerName']) for (const control of controls) {
    const p = payload(); p[key] = `LEFT${control}RIGHT`;
    assert.throws(() => h.mail.validatePerformanceReviewMailPayload(p), /invalid_payload/, key + ':' + control.charCodeAt(0));
    assert.equal(savedValidator(p).valid, false, key + ':' + control.charCodeAt(0));
  }
});

test('AM-05 legal Unicode TAB LF CR and the existing 8000 UTF16 boundary remain lossless', () => {
  const h = loadMailHarness();
  const p = payload();
  p.managerNote = '中😀e\u0301\tLEFT\r\nRIGHT\rEND';
  p.managerNote += 'x'.repeat(8000 - p.managerNote.length);
  assert.equal(p.managerNote.length, 8000);
  assert.doesNotThrow(() => h.mail.validatePerformanceReviewMailPayload(p));
  assert.equal(savedValidator(p).valid, true);
  const original = p.managerNote;
  h.mail.validatePerformanceReviewMailPayload(p); assert.equal(p.managerNote, original);
  p.managerNote += 'x'; assert.throws(() => h.mail.validatePerformanceReviewMailPayload(p), /invalid_payload/);
  for (const text of ['LEFT\ud800RIGHT', 'LEFT\udc00RIGHT', '\ud800\ud800', '\udc00\udc00']) {
    p.managerNote = text; assert.throws(() => h.mail.validatePerformanceReviewMailPayload(p), /invalid_payload/);
  }
});

test('AM-05 claim snapshot rejects unsupported private notes before entering the real Word renderer', async () => {
  const file = 'src/lib/performance-review-document.ts';
  const raw = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  const signature = 'export function buildPerformanceReviewDownload(document: PerformanceDocument) {';
  assert.equal(raw.split(signature).length, 2);
  const observed = raw.replace(signature, signature + '\n  console.info("synthetic-render-entry");');
  for (const company of ['MAM', 'Equipsy']) for (const note of ['LEFT\u000bRIGHT', 'LEFT\u007fRIGHT', 'LEFT\u001fRIGHT', 'LEFT\ud800RIGHT', 'LEFT\udc00RIGHT', '中😀\tLEFT\r\nRIGHT']) {
    const row = fixture(); row.payload.managerNote = note; row.payload.document.employee.company = company;
    const h = loadMailHarness({ sourcePatch: { [file]: observed }, rpc: name => ({ data: name === 'claim_performance_review_mail' ? [row] : true, error: null }), fetch: (_, init) => ack(JSON.parse(init.body)) });
    const result = await h.mail.dispatchPerformanceReviewMailOutbox();
    const valid = note.startsWith('中');
    assert.equal(h.logs.length, valid ? 1 : 0, 'renderer entry:' + company + ':' + JSON.stringify(note));
    assert.equal(h.requests.length, valid ? 1 : 0);
    assert.equal(result.providerAccepted, valid ? 1 : 0);
    assert.equal(result.held, valid ? 0 : 1);
    if (!valid) assert.equal(h.calls.length, 1);
  }
});

test('AM-05 saved n8n validator rejects lone surrogates while retaining valid surrogate pairs', () => {
  for (const key of ['managerNote', 'employeeName', 'managerName']) for (const value of ['LEFT\ud800RIGHT', 'LEFT\udc00RIGHT', '\ud800\ud800', '\udc00\udc00', '中😀\tLEFT\r\nRIGHT']) {
    const p = payload(); p[key] = value;
    assert.equal(savedValidator(p).valid, value.startsWith('中'), key + ':' + JSON.stringify(value));
  }
});

test('AM-05 saved n8n note domain matches the nonempty 8000 UTF16 mail consumer', () => {
  const h = loadMailHarness();
  for (const note of ['x'.repeat(8000), 'x'.repeat(8001), '', ' \t\r\n ']) {
    const p = payload(); p.managerNote = note;
    let admitted = true;
    try { h.mail.validatePerformanceReviewMailPayload(p); } catch { admitted = false; }
    assert.equal(savedValidator(p).valid, admitted, 'note UTF16 length:' + note.length);
  }
});

test('AM-05 canonical 120-codepoint supplementary names survive worker to saved n8n validation', async () => {
  const directory = readFileSync(new URL('../supabase/migrations/20260812223349_internal_org_directory.sql', import.meta.url), 'utf8');
  assert.match(directory, /char_length\(full_name\) between 1 and 120/);
  const fullName = '𠮷'.repeat(60) + ' ' + '𠮷'.repeat(59);
  assert.equal(Array.from(fullName).length, 120); assert.equal(fullName.length, 239);
  for (const company of ['MAM', 'Equipsy']) {
    const row = fixture(); row.payload.document.employee.company = company;
    row.payload.document.employee.name = fullName; row.payload.document.manager.name = fullName;
    let validated;
    const h = loadMailHarness({ rpc: name => ({ data: name === 'claim_performance_review_mail' ? [row] : true, error: null }), fetch: (_, init) => {
      const wire = JSON.parse(init.body); validated = savedValidator(wire);
      assert.equal(validated.valid, true);
      assert.ok(validated.graphBody.message.body.content.includes(fullName));
      return ack(wire);
    } });
    const result = await h.mail.dispatchPerformanceReviewMailOutbox();
    assert.equal(validated.valid, true, company + ': canonical Unicode name');
    assert.equal(result.providerAccepted, 1);
  }
  for (const key of ['employeeName', 'managerName']) for (const name of [fullName + '𠮷', 'A'.repeat(121)]) {
    const p = payload(); p[key] = name; assert.equal(savedValidator(p).valid, false);
  }
});
