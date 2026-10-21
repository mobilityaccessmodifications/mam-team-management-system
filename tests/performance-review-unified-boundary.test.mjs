import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as roleData from './browser/unified-role-data.mjs';
import * as reviewData from './performance-review-fixtures.mjs';
import { capabilities } from './helpers/unified-role-harness.mjs';

const managerId = roleData.syntheticRolePeople.find(person => person.role === 'manager').id;
const source = ts.transpileModule(readFileSync(new URL('./browser/unified-role-boundary.mjs', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture(native = false) {
  const mod = { exports: {} }, window = {};
  const results = { actor: { capabilities: capabilities('system_admin', null) }, roles: { [managerId]: { manager: { capabilities: capabilities('manager', managerId) } } } };
  const imports = { './unified-role-data.mjs': roleData, './leave-completed-data.mjs': { completedFixtureToday: '2026-10-21', leaveCompletedRequests() { throw new Error('Unexpected leave fixture use'); } }, '../performance-review-fixtures.mjs': reviewData };
  new Function('require', 'module', 'exports', 'location', 'window', 'sessionStorage', 'UNIFIED_ROLE_FIXTURE_RESULTS', source)(name => { assert.ok(Object.hasOwn(imports, name)); return imports[name]; }, mod, mod.exports, { search: `?performance-preview${native ? '&actor-role=manager' : ''}` }, window, { getItem: () => null }, results);
  return (name, ...args) => mod.exports.invokeServerAction('@/app/performance-reviews/actions', name, args);
}

test('unified browser fixture persists only the native manager own self draft with its exact revision', async () => {
  const call = fixture(true), data = (await call('loadPerformanceReviews')).data;
  const row = data.reviews.find(row => row.audience === 'employee');
  const input = { operationId: 'synthetic-self-save', command: 'save_self', reviewId: row.id, expectedRevision: row.selfRevision, input: { answers: row.selfAnswers.map((answer, index) => index ? answer : 'Synthetic saved self draft') } };
  const saved = await call('mutatePerformanceReview', input);
  assert.equal(saved.committed, true); assert.equal(saved.operationId, input.operationId);
  assert.equal(saved.review.selfRevision, 'self:1');
  assert.equal((await call('loadPerformanceReviews')).data.reviews.find(item => item.id === row.id).selfAnswers[0], 'Synthetic saved self draft');
  await assert.rejects(call('mutatePerformanceReview', input), /native employee scope/);
  await assert.rejects(call('mutatePerformanceReview', { ...input, reviewId: data.reviews.find(item => item.audience === 'manager').id }), /native employee scope/);
  await assert.rejects(call('mutatePerformanceReview', { ...input, expectedRevision: 'self:1' }, managerId), /manager scope/);
});

test('unified browser fixture keeps delegated own self assessment read-only', async () => {
  const call = fixture(), row = (await call('loadPerformanceReviews', managerId)).data.reviews.find(row => row.audience === 'employee');
  assert.equal(row.capabilities.saveSelf, false);
  await assert.rejects(call('mutatePerformanceReview', { operationId: 'synthetic-delegated-self', command: 'save_self', reviewId: row.id, expectedRevision: row.selfRevision, input: { answers: row.selfAnswers } }, managerId), /native employee scope/);
});

for (const native of [false, true]) test(`unified browser fixture preserves invitation completion during ${native ? 'native' : 'delegated'} manager autosave`, async () => {
  const call = fixture(native), target = native ? undefined : managerId;
  const row = (await call('loadPerformanceReviews', target)).data.reviews.find(row => row.audience === 'manager');
  const input = { operationId: 'synthetic-manager-save', command: 'save_manager', reviewId: row.id, expectedRevision: row.managerRevision, input: { answers: row.managerAnswers, ratings: row.ratings, summary: row.summary, overallRating: row.overallRating, managerNote: 'Synthetic autosaved note' } };
  const saved = await call('mutatePerformanceReview', input, target);
  assert.ok(row.managerCompletedAt); assert.equal(saved.review.managerCompletedAt, row.managerCompletedAt);
  assert.equal(saved.review.managerRevision, 'manager:0:1');
  assert.equal((await call('loadPerformanceReviews', target)).data.reviews.find(item => item.id === row.id).managerNote, 'Synthetic autosaved note');
  await assert.rejects(call('mutatePerformanceReview', input, target), /assigned row/);
});
