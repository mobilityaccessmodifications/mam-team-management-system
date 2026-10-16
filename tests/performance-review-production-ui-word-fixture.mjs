import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { document, meeting } from './performance-review-backend-fixtures.mjs';

export const originalWordSha256 = '7b6476d8fd051f5737fce6571ab826ed9535c6a9b5c000832783de71a2b03f40';
export const questionsSha256 = '9af2edc812ec465fe14a4d865e68606cee04d4fb122c5dcbf0ba9b94ebcdf561';
export const replacements = [
  ['SYNTHETIC TEST ONLY — no real employee information.', 'Confidential — internal performance review.'],
  ['Structured goal details are not captured separately in this test version. The goal table is intentionally blank; no goals or dates have been inferred.', 'Structured goal details are not captured separately. The goal table is intentionally blank; no goals or dates have been inferred.'],
];

export function adapter() {
  const path = fileURLToPath(new URL('../src/lib/performance-review-document.ts', import.meta.url));
  const result = buildSync({ entryPoints: [path], bundle: true, platform: 'node', format: 'cjs', write: false });
  const loaded = new Module(path);
  loaded.filename = path;
  loaded._compile(result.outputFiles[0].text, path);
  assert.equal(typeof loaded.exports.buildPerformanceReviewDownload, 'function');
  return loaded.exports;
}

export function sample(company, audience) {
  const row = document(audience);
  row.employee.company = company;
  row.selfAnswers = Array.from({ length: 12 }, (_, i) => `Synthetic employee evidence ${i + 1}`);
  if (audience !== 'employee') Object.assign(row, {
    managerAnswers: Array.from({ length: 12 }, (_, i) => `Synthetic manager evidence ${i + 1}`),
    ratings: Array(12).fill('2 Meets expectations'), summary: 'Synthetic summary',
    overallRating: '2 Meets expectations', meeting: { ...meeting, notes: 'Synthetic meeting notes' },
  });
  for (const key of audience === 'employee' ? ['managerAnswers', 'ratings', 'summary', 'overallRating', 'meeting', 'managerNote'] : ['managerNote']) {
    Object.defineProperty(row, key, { enumerable: true, get() { throw new Error('Private field read: ' + key); } });
  }
  return row;
}

export function parts(bytes) {
  assert.equal(Buffer.from(bytes).subarray(0, 4).toString('hex'), '504b0304');
  return Object.fromEntries(Object.entries(unzipSync(bytes)).map(([name, bytes]) => [name, strFromU8(bytes)]));
}
