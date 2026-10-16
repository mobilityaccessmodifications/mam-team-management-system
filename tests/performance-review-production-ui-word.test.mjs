import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { QUESTIONS } from '../src/lib/performance-review-questions.mjs';
import { adapter, parts, replacements, sample, originalWordSha256, questionsSha256 } from './performance-review-production-ui-word-fixture.mjs';

const { buildPerformanceReviewDownload } = adapter();

test('real DOCX XML carries the production confidentiality line for both companies and every audience', () => {
  for (const company of ['MAM', 'Equipsy']) for (const audience of ['employee', 'manager', 'admin']) {
    const result = buildPerformanceReviewDownload(sample(company, audience));
    assert.equal(result.fileName, `PR-2026-1-${audience === 'employee' ? 'employee' : 'manager'}.docx`);
    assert.equal(result.mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const xml = parts(result.bytes)['word/document.xml'];
    assert.equal(xml.includes(replacements[0][1]), true, `${company}/${audience}: production confidentiality text must be in the actual Word XML`);
    assert.equal(xml.includes(replacements[0][0]), false, `${company}/${audience}: obsolete synthetic disclaimer must be absent`);
  }
});

test('real manager and HR DOCX XML uses the production blank-goal explanation without exposing it to employees', () => {
  for (const company of ['MAM', 'Equipsy']) for (const audience of ['employee', 'manager', 'admin']) {
    const xml = parts(buildPerformanceReviewDownload(sample(company, audience)).bytes)['word/document.xml'];
    assert.equal(xml.includes(replacements[1][1]), audience !== 'employee', `${company}/${audience}: the audience-safe goal explanation must use production wording`);
    assert.equal(xml.includes(replacements[1][0]), false, `${company}/${audience}: obsolete test-version wording must be absent`);
  }
});

test('production Word inverse restores the original renderer and every DOCX part differs only by the approved text', async () => {
  const source = readFileSync(new URL('../src/lib/performance-review-word.mjs', import.meta.url), 'utf8');
  let original = source;
  for (const [before, after] of replacements) {
    assert.equal(original.split(after).length - 1, 1);
    assert.equal(original.includes(before), false);
    original = original.replace(after, before);
  }
  const hash = value => createHash('sha256').update(value).digest('hex');
  assert.equal(hash(original), originalWordSha256);
  assert.equal(hash(readFileSync(new URL('../src/lib/performance-review-questions.mjs', import.meta.url))), questionsSha256);
  const { buildReviewDocx } = await import('data:text/javascript;base64,' + Buffer.from(original).toString('base64'));
  const escapeXml = value => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
  for (const company of ['MAM', 'Equipsy']) for (const audience of ['employee', 'manager', 'admin']) {
    const input = sample(company, audience);
    const oldParts = parts(buildReviewDocx(input, QUESTIONS[company]));
    const newParts = parts(buildPerformanceReviewDownload(input).bytes);
    assert.deepEqual(Object.keys(newParts).sort(), ['[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels', 'word/document.xml', 'word/styles.xml'].sort());
    assert.deepEqual(Object.keys(newParts), Object.keys(oldParts));
    for (const name of Object.keys(oldParts)) {
      let expected = oldParts[name];
      if (name === 'word/document.xml') for (const [before, after] of replacements) expected = expected.replace(before, after);
      assert.equal(newParts[name] === expected, true, `${company}/${audience}: unexpected package/XML/layout difference in ${name}`);
    }
    const xml = newParts['word/document.xml'];
    assert.equal(QUESTIONS[company].length, 12);
    const runText = xml.replace(/<w:br\/>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, '');
    for (const question of QUESTIONS[company]) assert.equal(runText.includes(escapeXml(question)), true);
    assert.equal(xml.includes('w:fill="E9F3FA"'), true);
    assert.equal(xml.includes('w:fill="FFF6D8"'), audience !== 'employee');
    assert.equal(xml.includes('w:orient="landscape"'), true);
    assert.equal(newParts['word/styles.xml'].includes('w:ascii="Arial"'), true);
    assert.equal(xml.includes('Ratings: 1 Needs improvement | 2 Meets expectations | 3 Exceeds expectations | N Not enough evidence'), audience !== 'employee');
    if (audience === 'employee') {
      for (const privateText of ['Synthetic manager evidence', 'Synthetic summary', 'Synthetic meeting notes', 'Goals and meeting record']) assert.equal(xml.includes(privateText), false);
    } else {
      const goals = xml.match(/<w:tbl>.*?<\/w:tbl>/g).find(table => table.includes('Measure of success'));
      const rows = goals.match(/<w:tr>.*?<\/w:tr>/g);
      assert.equal(rows.length, 4);
      for (const row of rows.slice(1)) {
        const cells = [...row.matchAll(/<w:t xml:space="preserve">(.*?)<\/w:t>/g)].map(match => match[1]);
        assert.deepEqual(cells, ['', '', '', '', '']);
      }
    }
  }
});
