import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { buildReviewDocx } from '../src/lib/performance-review-word.mjs';
import { QUESTIONS } from '../src/lib/performance-review-questions.mjs';
import { replacements } from './performance-review-production-ui-word-fixture.mjs';

function adapter() {
  const path = fileURLToPath(new URL('../src/lib/performance-review-document.ts', import.meta.url));
  assert.ok(existsSync(path), 'The native Hub must supply its real audience-safe Word adapter');
  const result = buildSync({ entryPoints: [path], bundle: true, platform: 'node', format: 'cjs', write: false });
  const loaded = new Module(path);
  loaded.filename = path;
  loaded._compile(result.outputFiles[0].text, path);
  return loaded.exports;
}

function employeeDocument(company) {
  return {
    audience: 'employee', code: 'PR-2026-0001', cycle: '2026',
    employee: { id: '10000000-0000-4000-8000-000000000001', name: 'UAT Employee A', jobTitle: 'UAT role', company, team: 'UAT team' },
    manager: { id: '20000000-0000-4000-8000-000000000001', name: 'UAT Manager A' },
    selfAnswers: Array.from({ length: 12 }, (_, i) => `Synthetic response ${i + 1}`),
  };
}

test('native employee Word preserves both templates and only the approved production copy without reading manager fields', () => {
  const { buildPerformanceReviewDownload } = adapter();
  let source = readFileSync(new URL('../src/lib/performance-review-word.mjs', import.meta.url), 'utf8');
  for (const [before, after] of replacements) {
    assert.equal(source.split(after).length - 1, 1);
    assert.equal(source.includes(before), false);
    source = source.replace(after, before);
  }
  assert.equal(createHash('sha256').update(source).digest('hex'), '7b6476d8fd051f5737fce6571ab826ed9535c6a9b5c000832783de71a2b03f40');
  for (const company of ['MAM', 'Equipsy']) {
    const document = employeeDocument(company);
    for (const key of ['managerAnswers', 'ratings', 'summary', 'overallRating', 'managerNote', 'meeting']) {
      Object.defineProperty(document, key, { get() { throw new Error('Private manager field was read'); } });
    }
    const result = buildPerformanceReviewDownload(document);
    assert.deepEqual(Buffer.from(result.bytes), Buffer.from(buildReviewDocx(employeeDocument(company), QUESTIONS[company])));
    assert.equal(result.fileName, 'PR-2026-0001-employee.docx');
    assert.equal(result.mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  }
});

test('native manager and HR Word preserve both templates and never read Manager note', () => {
  const { buildPerformanceReviewDownload } = adapter();
  for (const company of ['MAM', 'Equipsy']) {
    for (const audience of ['manager', 'admin']) {
      const document = {
        ...employeeDocument(company), audience,
        managerAnswers: Array.from({ length: 12 }, (_, i) => `Synthetic manager response ${i + 1}`),
        ratings: Array(12).fill('2 Meets expectations'), summary: 'Synthetic summary', overallRating: '2 Meets expectations',
        meeting: { date: '2026-09-01', time: '10:00', duration: 30, mode: 'in_person', location: 'UAT room', notes: 'Synthetic meeting' },
      };
      Object.defineProperty(document, 'managerNote', { get() { throw new Error('Manager note must not enter Word'); } });
      const result = buildPerformanceReviewDownload(document);
      assert.deepEqual(Buffer.from(result.bytes), Buffer.from(buildReviewDocx(document, QUESTIONS[company])));
      assert.equal(result.fileName, 'PR-2026-0001-manager.docx');
      assert.equal(result.mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    }
  }
});
