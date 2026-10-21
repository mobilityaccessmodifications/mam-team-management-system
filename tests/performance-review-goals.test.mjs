import assert from 'node:assert/strict';
import test from 'node:test';
import { unzipSync, strFromU8 } from 'fflate';
import { loadModule } from './helpers/contact-lifetime-harness.mjs';
import { review as backendReview, document as backendDocument, operationId, reviewId } from './performance-review-backend-fixtures.mjs';
import { goal, review, workspace, ratings } from './performance-review-fixtures.mjs';
import { mount } from './performance-review-harness.mjs';
import { buildReviewDocx } from '../src/lib/performance-review-word.mjs';
import { QUESTIONS } from '../src/lib/performance-review-questions.mjs';
const rules = () => loadModule('src/lib/performance-review-rules.ts');
const manager = goals => ({ operationId, reviewId, expectedRevision: 'manager:0:0', command: 'save_manager', input: { answers: Array(12).fill(''), ratings: Array(12).fill(''), summary: '', overallRating: '', managerNote: '', goals } });
const writes = h => h.calls.filter(c => c.name === 'mutatePerformanceReview');
const tick = async h => { h.advanceTimers(600); await h.settle(); };
function commit(input, row) {
  return { ok: true, committed: true, operationId: input.operationId, review: { ...row, managerRevision: input.expectedRevision.replace(/\d+$/, n => String(Number(n) + 1)), managerAnswers: [...input.input.answers], ratings: [...input.input.ratings], summary: input.input.summary, overallRating: input.input.overallRating, managerNote: input.input.managerNote, goals: structuredClone(input.input.goals) } };
}

test('goal drafts retain partial rows while completed goals require all five fields and a real date', () => {
 const r = rules(), partial = { ...goal(), priority: '', dueDate: '' };
 assert.deepEqual(r.parseMutationInput(manager([partial])), manager([partial]));
 assert.equal(r.completePerformanceGoals([]), false);
 assert.equal(r.completePerformanceGoals([goal()]), true);
 for (const key of Object.keys(goal())) assert.equal(r.completePerformanceGoals([{ ...goal(), [key]: '\u2003' }]), false);
 assert.equal(r.completePerformanceGoals([{ ...goal(), dueDate: '2026-02-29' }]), false);
 assert.equal(r.completePerformanceGoals([{ ...goal(), dueDate: '2028-02-29' }]), true);
 const legacy = manager([]); delete legacy.input.goals;
 assert.deepEqual(r.parseMutationInput(legacy), legacy, 'Legacy replay bodies must not gain an empty goals field');
});

test('goal input rejects unknown keys, oversized or sparse rows, invalid dates and accessors without reading them', () => {
 const r = rules();
 for (const goals of [Array.from({ length: 11 }, goal), [{ ...goal(), priority: 'x'.repeat(2001) }], [{ ...goal(), priority: '🦽'.repeat(1001) }], [{ ...goal(), dueDate: '2026-02-30' }], [{ ...goal(), extra: 'injected' }], [null], Array(1)]) assert.throws(() => r.parseMutationInput(manager(goals)));
 let reads = 0;
 const g = goal(); Object.defineProperty(g, 'priority', { enumerable: true, get() { reads++; throw new Error('must not read'); } });
 assert.throws(() => r.parseMutationInput(manager([g]))); assert.equal(reads, 0);
 const a = [goal()]; Object.defineProperty(a, '0', { get() { reads++; return goal(); } });
 assert.throws(() => r.parseMutationInput(manager(a))); assert.equal(reads, 0);
 const original = manager([goal()]), parsed = r.parseMutationInput(original); original.input.goals[0].priority = 'later edit';
 assert.equal(parsed.input.goals[0].priority, goal().priority);
});

test('manager reads normalize old snapshots without changing source objects and employee copies reject goals', () => {
 const r = rules();
 for (const audience of ['manager', 'admin']) {
  const row = backendReview(audience); delete row.goals;
  const doc = backendDocument(audience); delete doc.goals;
  assert.deepEqual(r.parseReview(row).goals, []); assert.equal(Object.hasOwn(row, 'goals'), false);
  assert.deepEqual(r.parseDocument(doc).goals, []); assert.equal(Object.hasOwn(doc, 'goals'), false);
  assert.deepEqual(r.parseReview({ ...row, goals: [goal()] }).goals, [goal()]);
  assert.deepEqual(r.parseDocument({ ...doc, goals: [goal()] }).goals, [goal()]);
 }
 let reads = 0;
 for (const input of [backendReview(), backendDocument()]) {
  Object.defineProperty(input, 'goals', { enumerable: true, get() { reads++; throw new Error('private'); } });
  assert.throws(() => input.id ? r.parseReview(input) : r.parseDocument(input));
 }
 assert.equal(reads, 0);
});

for (const company of ['MAM', 'Equipsy']) test(`${company} completed Word captures each goal field, row order and escaped content`, () => {
 const doc = backendDocument('manager'); doc.employee.company = company;
 doc.goals = [{ ...goal(), priority: 'First <goal> & evidence', measureOfSuccess: 'Line one\nLine two', progressCheck: 'Check\tmonthly' }, { ...goal(), priority: 'Second goal', dueDate: '2028-02-29' }];
 Object.defineProperty(doc, 'managerNote', { get() { throw new Error('private note'); } });
 const xml = strFromU8(unzipSync(buildReviewDocx(doc, QUESTIONS[company]))['word/document.xml']);
 for (const value of ['First &lt;goal&gt; &amp; evidence', 'Second goal', '2028-02-29', 'Synthetic reviewer provides training']) assert.ok(xml.includes(value));
 assert.ok(xml.indexOf('First &lt;goal&gt;') < xml.indexOf('Second goal'));
 assert.ok(xml.includes('<w:br/>') && xml.includes('<w:tab/>'));
 assert.ok(!xml.includes('goal table is intentionally blank'));
 const legacy = { ...doc }; delete legacy.goals;
 assert.deepEqual(buildReviewDocx(legacy, QUESTIONS[company]), buildReviewDocx({ ...legacy, goals: [] }, QUESTIONS[company]));
});

test('manager can add, edit, remove and autosave goals without inviting or submitting', async () => {
 let stored = review('manager', 'MAM', { goals: [] });
 const ports = { loadPerformanceReviews: async () => ({ ok: true, data: workspace('manager', 'MAM', { reviews: [stored] }) }), mutatePerformanceReview: async input => { const result = commit(input, stored); stored = result.review; return result; } };
 const h = mount(workspace('manager', 'MAM', { reviews: [stored] }), ports);
 try {
  await h.settle(); h.click('Add goal'); h.render(); h.change('goal-0-priority', 'Agreed at meeting'); await tick(h);
  assert.equal(writes(h)[0].args[0].command, 'save_manager'); assert.equal(stored.goals[0].priority, 'Agreed at meeting');
  h.click('Add goal'); h.render(); h.change('goal-1-priority', 'Remove this row'); h.click('Remove goal 1'); h.render(); await tick(h);
  assert.equal(stored.goals.length, 1); assert.equal(stored.goals[0].priority, 'Remove this row');
  assert.ok(writes(h).every(c => c.args[0].command === 'save_manager')); assert.equal(h.beforeUnload().prevented, false);
 } finally { h.unmount(); }
 const fresh = mount(workspace('manager', 'MAM', { reviews: [stored] }), ports);
 try { await fresh.settle(); assert.equal(fresh.field('goal-0-priority').props.value, 'Remove this row'); assert.equal(writes(fresh).length, 0); } finally { fresh.unmount(); }
});

test('new in-person meetings default to editable Boardroom and every rating is directly selectable', async () => {
 const h = mount(workspace('manager', 'MAM', { reviews: [review('manager', 'MAM', { goals: [], managerCompletedAt: '2026-10-01T00:00:00Z' })] }));
 try {
  await h.settle(); assert.equal(h.field('meeting-location').props.value, 'Boardroom');
  h.change('meeting-location', 'Alternative room'); assert.equal(h.field('meeting-location').props.value, 'Alternative room');
  h.change('meeting-mode', 'teams'); h.change('meeting-location', 'https://teams.microsoft.com/example'); h.change('meeting-mode', 'in_person');
  assert.equal(h.field('meeting-location').props.value, 'Boardroom');
  for (const name of ['rating-0', 'overallRating']) {
   const options = h.all.filter(n => n.type === 'input' && n.props.type === 'radio' && n.props.name === name);
   assert.deepEqual(options.map(n => n.props.value), ratings);
   h.change(name, ratings[2]); assert.equal(h.all.find(n => n.props?.name === name && n.props.value === ratings[2]).props.checked, true);
  }
  assert.equal(h.button('Save and send final review').props.disabled, true);
 } finally { h.unmount(); }
});


test('a completed past meeting cannot finalize without complete goals', async () => {
 const row = review('manager', 'MAM', { goals: [], managerCompletedAt: '2026-10-01T00:00:00Z', meeting: { date: '2026-10-01', time: '10:00', duration: 30, mode: 'in_person', location: 'Boardroom', notes: '' } });
 const h = mount(workspace('manager', 'MAM', { reviews: [row] }));
 try {
  await h.settle(); h.change('held', true);
  assert.equal(h.button('Save and send final review').props.disabled, true);
  h.click('Add goal'); h.render();
  const fields = { priority: 'priority', measureOfSuccess: 'measure', supportAndResponsiblePerson: 'support', dueDate: 'due', progressCheck: 'check' };
  for (const [key, suffix] of Object.entries(fields)) h.change(`goal-0-${suffix}`, goal()[key]);
  assert.equal(h.button('Save and send final review').props.disabled, false);
  h.change('goal-0-check', '');
  assert.equal(h.button('Save and send final review').props.disabled, true);
  assert.equal(writes(h).length, 0);
 } finally { h.unmount(); }
});
