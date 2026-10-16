import test from 'node:test';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { mount } from './performance-review-harness.mjs';
import { workspace, review, documentFor, deferred, failure, ids } from './performance-review-fixtures.mjs';
import { unzipSync, strFromU8 } from 'fflate';
import { QUESTIONS } from '../src/lib/performance-review-questions.mjs';

test('native self workspace loads actor-owned records and both company prompts without reading manager fields', async () => {
  for (const company of ['MAM', 'Equipsy']) {
    const data = workspace('employee', company);
    Object.defineProperty(data.reviews[0], 'managerNote', { get() { throw new Error('Employee must never read managerNote'); } });
    const h = mount(data); await h.settle();
    assert.equal(h.calls[0].name, 'loadPerformanceReviews');
    assert.ok(h.text.includes('Performance reviews'));
    for (let i = 0; i < 12; i++) {
      assert.ok(h.text.includes(QUESTIONS[company][i]), 'Frozen prompt '+i);
      assert.equal(h.field('self-'+i).props.value, data.reviews[0].selfAnswers[i]);
    }
    assert.ok(!h.text.includes('Manager assessment'));
    assert.ok(!JSON.stringify(h.hooks).includes('managerNote'));
    h.unmount();
  }
});

test('self save and submit use exact revisioned commands, validate required answers and lock after submission', async () => {
  const pending = deferred();
  const h = mount(workspace(), { mutatePerformanceReview: () => pending.promise }); await h.settle();
  h.change('self-0', 'Unsaved synthetic draft');
  const save = h.button('Save self draft').props.onClick;
  const first = save(); save();
  h.render();
  assert.equal(h.button('Save self draft').props.disabled, true);
  const writes = h.calls.filter(c => c.name === 'mutatePerformanceReview');
  assert.equal(writes.length, 1);
  const sent = writes[0].args[0];
  assert.match(sent.operationId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(sent, { operationId: sent.operationId, reviewId: review().id, expectedRevision: 'self:0', command: 'save_self', input: { answers: ['Unsaved synthetic draft', ...review().selfAnswers.slice(1)] } });
  pending.resolve({ ok: true, committed: true, operationId: sent.operationId, review: review('employee', 'MAM', { selfRevision: 'self:1', selfAnswers: sent.input.answers }) });
  await first; await h.settle();
  assert.ok(h.text.includes('Saved.'));
  h.change('self-3', '   '); h.submit('Self assessment'); await h.settle();
  assert.equal(h.calls.filter(c => c.name === 'mutatePerformanceReview').length, 1);
  assert.ok(h.text.includes('Complete the required answers.'));
  h.change('self-3', 'Required achievement');
  h.ports.mutatePerformanceReview = async input => ({ ok: true, committed: true, operationId: input.operationId, review: review('employee', 'MAM', { selfRevision: 'self:2', selfSubmittedAt: '2026-10-01T01:00:00Z', selfStatus: 'manager_review', capabilities: { saveSelf: false, submitSelf: false, downloadDocument: true }, selfAnswers: input.input.answers }) });
  h.submit('Self assessment'); await h.settle();
  assert.equal(h.calls.at(-1).args[0].command, 'submit_self');
  assert.equal(h.calls.at(-1).args[0].expectedRevision, 'self:1');
  assert.equal(h.field('self-0').props.disabled, true);
  h.submit('Self assessment'); await h.settle();
  assert.equal(h.calls.filter(c => c.name === 'mutatePerformanceReview').length, 2);
  h.unmount();
});

test('assigned manager assesses with original ratings while HR is read-only and manager own review stays self-only', async () => {
  for (const audience of ['manager', 'admin']) {
    const data = workspace(audience, 'Equipsy');
    const h = mount(data, { mutatePerformanceReview: async input => ({ ok: true, committed: true, operationId: input.operationId, review: review('manager', 'Equipsy', { managerRevision: 'manager:0:1', managerCompletedAt: input.command === 'complete_manager' ? '2026-10-01T02:00:00Z' : null, managerAnswers: input.input.answers, ratings: input.input.ratings, summary: input.input.summary, overallRating: input.input.overallRating, managerNote: input.input.managerNote }) }) });
    await h.settle();
    assert.ok(h.text.includes('Manager assessment'));
    assert.equal(h.field('managerNote').props.value, 'PRIVATE-SYNTHETIC-MANAGER-NOTE');
    assert.deepEqual(h.all.filter(n => n.type === 'option' && n.props.value).slice(0, 4).map(n => n.props.children), ['1 Needs improvement', '2 Meets expectations', '3 Exceeds expectations', 'N Not enough evidence']);
    if (audience === 'admin') {
      for (const n of h.all.filter(n => ['input', 'select', 'textarea'].includes(n.type))) assert.equal(n.props.disabled, true);
      h.submit('Self assessment'); h.submit('Manager assessment'); await h.settle();
      assert.equal(h.calls.filter(c => c.name === 'mutatePerformanceReview').length, 0);
      assert.ok(!h.all.some(n => n.type === 'button' && /Save|Complete|Submit/.test(n.props.children)));
    } else {
      h.change('manager-0', 'Revised manager evidence');
      h.click('Save manager draft'); await h.settle();
      const sent = h.calls.at(-1).args[0];
      assert.equal(sent.command, 'save_manager'); assert.equal(sent.expectedRevision, 'manager:0:0');
      assert.deepEqual(Object.keys(sent.input).sort(), ['answers','managerNote','overallRating','ratings','summary']);
      assert.equal(sent.input.answers[0], 'Revised manager evidence');
      h.change('managerNote', ''); h.submit('Manager assessment'); await h.settle();
      assert.equal(h.calls.filter(c => c.name === 'mutatePerformanceReview').length, 1);
      h.change('managerNote', 'Required private note'); h.submit('Manager assessment'); await h.settle();
      assert.equal(h.calls.at(-1).args[0].command, 'complete_manager');
      assert.equal(h.calls.at(-1).args[0].expectedRevision, 'manager:0:1');
    }
    h.unmount();
  }
  const own = workspace('employee', 'MAM'); own.viewerContext.role = 'manager';
  const h = mount(own); await h.settle();
  assert.ok(!h.text.includes('Manager assessment')); assert.ok(!JSON.stringify(h.hooks).includes('managerNote'));
  h.unmount();
});

test('meeting registration is not held and finalisation requires explicit held plus completed assessment', async () => {
  let authoritative = review('manager');
  const h = mount(workspace('manager'), { mutatePerformanceReview: async input => {
    if (input.command === 'submit_review' && input.input.date === '2099-01-01') return failure('invalid');
    authoritative = { ...authoritative, managerRevision: 'manager:0:1', meeting: { ...input.input }, ...(input.command === 'submit_review' ? { finalisedAt: '2026-10-02T03:00:00Z' } : {}) };
    return { ok: true, committed: true, operationId: input.operationId, review: authoritative };
  } }); await h.settle();
  h.change('meeting-date', '2099-01-01'); h.change('meeting-time', '10:30'); h.change('meeting-duration', '45'); h.change('meeting-mode', 'teams'); h.change('meeting-location', 'Synthetic meeting room'); h.change('meeting-notes', 'Synthetic notes');
  h.click('Save meeting'); await h.settle();
  const sent = h.calls.at(-1).args[0];
  assert.equal(sent.command, 'save_meeting');
  assert.deepEqual(sent.input, { date: '2099-01-01', time: '10:30', duration: 45, mode: 'teams', location: 'Synthetic meeting room', notes: 'Synthetic notes' });
  assert.equal(h.field('held').props.checked, false);
  h.submit('Review meeting'); await h.settle();
  assert.equal(h.calls.filter(c => c.name === 'mutatePerformanceReview').length, 1);
  authoritative = { ...authoritative, managerCompletedAt: '2026-10-01T02:00:00Z' };
  h.ports.loadPerformanceReviews = async () => ({ ok: true, data: workspace('manager', 'MAM', { reviews: [authoritative] }) });
  h.click('Reload'); await h.settle();
  h.change('held', true); h.submit('Review meeting'); await h.settle();
  assert.equal(h.calls.at(-1).args[0].command, 'submit_review');
  assert.equal(h.calls.at(-1).args[0].input.held, true);
  assert.ok(h.text.includes('Synthetic invalid.'));
  assert.equal(h.field('meeting-date').props.value, '2099-01-01');
  h.change('meeting-date', '2026-10-01'); h.submit('Review meeting'); await h.settle();
  assert.equal(h.field('meeting-date').props.disabled, true);
  const count = h.calls.length; h.submit('Review meeting'); await h.settle(); assert.equal(h.calls.length, count);
  h.unmount();
});

test('yearly creation selects only startable people, validates date/cycle and submits once', async () => {
  const data = workspace('manager'); data.startablePeople = [data.reviews[0].employee];
  const pending = deferred(); const h = mount(data, { startPerformanceReview: () => pending.promise }); await h.settle();
  h.click('New yearly review'); h.render();
  assert.equal(h.all.filter(n => n.type === 'option' && n.props.value === data.startablePeople[0].id).length, 1);
  h.change('start-person', 'unlisted-person'); h.change('start-cycle', '2026'); h.change('start-dueDate', '2026-11-30'); h.submit('New yearly review'); await h.settle();
  assert.equal(h.calls.filter(c => c.name === 'startPerformanceReview').length, 0);
  h.change('start-person', data.startablePeople[0].id); h.change('start-cycle', '26'); h.submit('New yearly review'); await h.settle();
  assert.equal(h.calls.filter(c => c.name === 'startPerformanceReview').length, 0);
  h.change('start-cycle', '2026'); h.change('start-dueDate', '2026-02-30'); h.submit('New yearly review'); await h.settle();
  assert.equal(h.calls.filter(c => c.name === 'startPerformanceReview').length, 0);
  h.change('start-dueDate', '2026-11-30'); const form = h.all.find(n => n.type === 'form' && n.props['aria-label'] === 'New yearly review');
  form.props.onSubmit({ preventDefault() {} }); form.props.onSubmit({ preventDefault() {} }); h.render();
  const writes = h.calls.filter(c => c.name === 'startPerformanceReview'); assert.equal(writes.length, 1);
  const sent = writes[0].args[0]; assert.deepEqual(sent, { operationId: sent.operationId, employeePersonId: data.startablePeople[0].id, cycle: '2026', dueDate: '2026-11-30' });
  pending.resolve({ ok: true, committed: true, operationId: sent.operationId, existing: true, review: data.reviews[0] }); await h.settle();
  assert.ok(h.text.includes('Review opened.'));
  assert.equal(h.all.filter(n => n.type === 'form' && n.props['aria-label'] === 'New yearly review').length, 0);
  h.unmount();
});

test('Word download calls the frozen adapter for both companies and all audiences with native Blob cleanup', async () => {
  for (const company of ['MAM', 'Equipsy']) for (const audience of ['employee', 'manager', 'admin']) {
    const data = workspace(audience, company), doc = documentFor(data.reviews[0]);
    const h = mount(data, { getPerformanceReviewDocument: async () => ({ ok: true, document: doc }) }); await h.settle();
    await h.click('Download Word'); await h.settle();
    assert.deepEqual(h.calls.at(-1), { name: 'getPerformanceReviewDocument', args: [data.reviews[0].id] });
    assert.deepEqual(h.built, [doc]); assert.equal(h.downloads.length, 1);
    const download = h.downloads[0]; assert.match(download.fileName, /\.docx$/);
    assert.equal(download.blob.type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const xml = strFromU8(unzipSync(new Uint8Array(await download.blob.arrayBuffer()))['word/document.xml']);
    assert.ok(xml.includes(company === 'MAM' ? 'Your Safety First' : 'Purpose Built'));
    assert.ok(!xml.includes('PRIVATE-SYNTHETIC-MANAGER-NOTE'));
    if (audience === 'employee') assert.ok(!xml.includes('Synthetic feedback'));
    if (audience === 'employee') { h.timers(); assert.deepEqual(h.revoked, [download.href]); }
    else { h.unmount(); assert.deepEqual(h.revoked, [download.href]); }
    if (audience === 'employee') h.unmount();
  }
  const h = mount(workspace(), { getPerformanceReviewDocument: async () => failure('unavailable') }); await h.settle();
  await h.click('Download Word'); await h.settle(); assert.equal(h.built.length, 0); assert.equal(h.downloads.length, 0);
  h.unmount();
});

test('manual reload fences retired callbacks and does not overwrite dirty drafts or rebase their CAS revision', async () => {
  const pending = deferred(); let write;
  const h = mount(workspace(), { mutatePerformanceReview: async input => { write = input; return failure('conflict'); } }); await h.settle();
  const oldReload = h.button('Reload').props.onClick;
  h.ports.loadPerformanceReviews = () => pending.promise;
  h.click('Reload'); h.render(); h.change('self-0', 'Dirty draft written after read started');
  pending.resolve({ ok: true, data: workspace('employee', 'MAM', { reviews: [review('employee', 'MAM', { selfRevision: 'self:9', selfAnswers: Array(12).fill('Late authoritative answer') })] }) }); await h.settle();
  assert.equal(h.field('self-0').props.value, 'Dirty draft written after read started');
  h.click('Save self draft'); await h.settle(); assert.equal(write.expectedRevision, 'self:0');
  assert.equal(h.field('self-0').props.value, 'Dirty draft written after read started'); assert.ok(h.text.includes('Synthetic conflict.'));
  const calls = h.calls.length; oldReload(); await h.settle(); assert.equal(h.calls.length, calls, 'Retired reload must not dispatch');
  h.unmount();
});

test('selection epoch handles A to B to A and rejects late workspace reads', async () => {
  const a = review('manager'), b = review('manager', 'Equipsy', { id: ids.other, code: 'PR-2026-0002', employee: { ...review('manager').employee, id: '22000000-0000-4000-8000-000000000003', name: 'Synthetic Second', company: 'Equipsy' } });
  const initial = workspace('manager', 'MAM', { reviews: [a, b] }), pending = deferred();
  const h = mount(initial); await h.settle(); h.ports.loadPerformanceReviews = () => pending.promise;
  h.click('Reload'); h.render();
  h.click(`${b.code} — ${b.employee.name} — ${b.cycle}`); h.render();
  h.click(`${a.code} — ${a.employee.name} — ${a.cycle}`); h.render();
  h.change('managerNote', 'New A draft after A B A');
  pending.resolve({ ok: true, data: workspace('manager', 'MAM', { reviews: [{ ...a, managerNote: 'LATE-PRIVATE-RESPONSE' }, b] }) }); await h.settle();
  assert.equal(h.field('managerNote').props.value, 'New A draft after A B A');
  assert.ok(!JSON.stringify(h.hooks).includes('LATE-PRIVATE-RESPONSE'));
  h.unmount();
});

test('uncertain writes retain drafts, never replay and require explicit committed receipt reconciliation', async () => {
  for (const mode of ['uncertain', 'throw', 'bad-receipt']) {
    const h = mount(workspace(), { mutatePerformanceReview: async () => {
      if (mode === 'throw') throw new Error('SYNTHETIC-PROVIDER-SECRET');
      if (mode === 'bad-receipt') return { ok: true, committed: true, operationId: 'different-receipt', review: review() };
      return failure('uncertain', true);
    }, reconcilePerformanceReviewOperation: async () => ({ ok: true, data: { status: 'not_found', review: null } }) }); await h.settle();
    h.change('self-0', 'Draft held after unknown commit'); const saved = h.button('Save self draft').props.onClick;
    saved(); await h.settle();
    assert.equal(h.button('Save self draft').props.disabled, true);
    assert.equal(h.field('self-0').props.value, 'Draft held after unknown commit');
    assert.ok(!h.text.includes('SYNTHETIC-PROVIDER-SECRET'));
    h.submit('Self assessment'); saved(); await h.settle();
    assert.equal(h.calls.filter(c => c.name === 'mutatePerformanceReview').length, 1);
    h.click('Reload'); await h.settle();
    assert.equal(h.button('Save self draft').props.disabled, true);
    h.click('Reconcile update'); await h.settle();
    const mutation = h.calls.find(c => c.name === 'mutatePerformanceReview').args[0];
    assert.deepEqual(h.calls.at(-1), { name: 'reconcilePerformanceReviewOperation', args: [{ operationId: mutation.operationId, reviewId: mutation.reviewId }] });
    assert.equal(h.button('Save self draft').props.disabled, true, 'not_found does not prove no commit');
    assert.equal(h.field('self-0').props.value, 'Draft held after unknown commit');
    h.ports.reconcilePerformanceReviewOperation = async () => ({ ok: true, data: { status: 'committed', review: review('employee', 'MAM', { selfRevision: 'self:1', selfAnswers: ['Receipt confirmed draft', ...review().selfAnswers.slice(1)] }) } });
    h.click('Reconcile update'); await h.settle();
    assert.equal(h.field('self-0').props.value, 'Receipt confirmed draft');
    assert.equal(h.button('Save self draft').props.disabled, false);
    assert.ok(h.text.includes('Update confirmed.'));
    assert.equal(h.all.find(n => n.type === 'p' && n.props.children === 'Update confirmed.').props.role, 'status');
    assert.equal(h.calls.filter(c => c.name === 'mutatePerformanceReview').length, 1);
    h.unmount();
  }
});

test('uncertain yearly creation reconciles with null review id and does not create twice', async () => {
  const data = workspace('manager'); data.startablePeople = [data.reviews[0].employee];
  const h = mount(data, { startPerformanceReview: async () => failure('uncertain', true), reconcilePerformanceReviewOperation: async () => ({ ok: true, data: { status: 'committed', review: data.reviews[0] } }) }); await h.settle();
  h.click('New yearly review'); h.render(); h.change('start-person', data.startablePeople[0].id); h.change('start-cycle', '2026'); h.change('start-dueDate', '2026-11-30');
  h.submit('New yearly review'); await h.settle(); h.submit('New yearly review'); await h.settle();
  assert.equal(h.calls.filter(c => c.name === 'startPerformanceReview').length, 1);
  assert.equal(h.field('start-cycle').props.value, '2026');
  h.click('Reconcile update'); await h.settle();
  assert.equal(h.calls.at(-1).args[0].reviewId, null);
  assert.equal(h.all.filter(n => n.type === 'form' && n.props['aria-label'] === 'New yearly review').length, 0);
  h.unmount();
});

test('known commit followed by reload failure never retries the original write', async () => {
  const h = mount(workspace(), { mutatePerformanceReview: async input => ({ ok: true, committed: true, operationId: input.operationId, review: review('employee', 'MAM', { selfRevision: 'self:1', selfAnswers: input.input.answers }) }) }); await h.settle();
  h.change('self-0', 'Committed synthetic value'); const original = h.button('Save self draft').props.onClick;
  original(); await h.settle(); h.ports.loadPerformanceReviews = async () => failure('unavailable');
  h.click('Reload'); await h.settle(); original(); await h.settle();
  assert.equal(h.field('self-0').props.value, 'Committed synthetic value');
  assert.equal(h.calls.filter(c => c.name === 'mutatePerformanceReview').length, 1);
  h.unmount();
});

test('native logout clears private DTOs, drafts, creation form and Blob URLs before late manager reads can return', async () => {
  const data = workspace('manager'); data.startablePeople = [data.reviews[0].employee];
  const h = mount(data, { getPerformanceReviewDocument: async () => ({ ok: true, document: documentFor(data.reviews[0]) }) }); await h.settle();
  h.auth('INITIAL_SESSION', ids.actor);
  await h.click('Download Word'); await h.settle();
  h.change('managerNote', 'PRIVATE-UNSAVED-AUTH-DRAFT'); h.click('New yearly review'); h.render(); h.change('start-cycle', '2026');
  const oldSave = h.button('Save manager draft').props.onClick, oldDownload = h.button('Download Word').props.onClick, oldCreate = h.button('New yearly review').props.onClick;
  const pending = deferred(); h.ports.loadPerformanceReviews = () => pending.promise; h.click('Reload'); h.render();
  h.auth('SIGNED_OUT');
  assert.ok(!JSON.stringify(h.hooks).includes('PRIVATE-'));
  assert.ok(!h.text.includes('Synthetic Colleague'));
  assert.equal(h.all.filter(n => n.type === 'form').length, 0);
  assert.deepEqual(h.revoked, [h.downloads[0].href]);
  const count = h.calls.length; oldSave(); oldDownload(); oldCreate(); await h.settle(); assert.equal(h.calls.length, count);
  pending.resolve({ ok: true, data }); await h.settle();
  assert.ok(!JSON.stringify(h.hooks).includes('PRIVATE-'));
  h.ports.loadPerformanceReviews = async () => ({ ok: true, data: workspace() });
  h.auth('SIGNED_IN', ids.actor); await h.settle();
  assert.ok(h.text.includes('Self assessment')); assert.ok(!h.text.includes('Manager assessment'));
  h.unmount();
});

test('definitive action permission loss clears private state while transient failures preserve manager drafts', async () => {
  for (const route of ['load', 'mutation', 'document', 'reconcile', 'start']) {
    const data = workspace('manager'); data.startablePeople = [data.reviews[0].employee];
    const h = mount(data, { mutatePerformanceReview: async () => route === 'reconcile' ? failure('uncertain', true) : failure('forbidden'), getPerformanceReviewDocument: async () => failure('unauthenticated'), reconcilePerformanceReviewOperation: async () => failure('forbidden'), startPerformanceReview: async () => failure('forbidden') }); await h.settle();
    h.change('managerNote', 'PRIVATE-DRAFT-TO-ERASE');
    if (route === 'load') { h.ports.loadPerformanceReviews = async () => failure('forbidden'); h.click('Reload'); }
    if (route === 'mutation' || route === 'reconcile') { h.click('Save manager draft'); await h.settle(); }
    if (route === 'document') h.click('Download Word');
    if (route === 'reconcile') h.click('Reconcile update');
    if (route === 'start') { h.click('New yearly review'); h.render(); h.change('start-person', data.startablePeople[0].id); h.change('start-cycle', '2026'); h.change('start-dueDate', '2026-11-30'); h.submit('New yearly review'); }
    await h.settle(); assert.ok(!JSON.stringify(h.hooks).includes('PRIVATE-'), route+' clears private state'); assert.equal(h.all.filter(n => n.type === 'form').length, 0); h.unmount();
  }
  for (const code of ['conflict', 'unavailable']) {
    const h = mount(workspace('manager'), { mutatePerformanceReview: async () => failure(code) }); await h.settle();
    h.change('managerNote', 'Retained transient draft'); h.click('Save manager draft'); await h.settle();
    assert.equal(h.field('managerNote').props.value, 'Retained transient draft'); assert.equal(h.button('Save manager draft').props.disabled, false); h.unmount();
  }
});

test('role downgrade and vanished selection erase manager caches and retire pending mutation continuations', async () => {
  const pending = deferred(); const h = mount(workspace('manager'), { mutatePerformanceReview: () => pending.promise }); await h.settle();
  h.change('managerNote', 'PRIVATE-INFLIGHT-DRAFT'); h.click('Save manager draft'); h.render();
  const input = h.calls.at(-1).args[0];
  h.ports.loadPerformanceReviews = async () => ({ ok: true, data: workspace('employee', 'MAM', { reviews: [] }) }); h.click('Reload'); await h.settle();
  assert.ok(!JSON.stringify(h.hooks).includes('PRIVATE-'));
  pending.resolve({ ok: true, committed: true, operationId: input.operationId, review: review('manager', 'MAM', { managerNote: 'PRIVATE-LATE-RESURRECTION' }) }); await h.settle();
  assert.ok(!JSON.stringify(h.hooks).includes('PRIVATE-'));
  assert.equal(h.all.filter(n => n.type === 'form').length, 0); h.unmount();
});

test('unsaved manager edits invalidate completion locally and sibling saves preserve unsaved drafts', async () => {
  let row = review('manager', 'MAM', { managerCompletedAt: '2026-10-01T02:00:00Z', meeting: { date: '2026-10-01', time: '11:00', duration: 30, mode: 'in_person', location: 'Synthetic room', notes: '' } });
  const h = mount(workspace('manager', 'MAM', { reviews: [row] }), { mutatePerformanceReview: async input => {
    row = { ...row, managerRevision: 'manager:0:1', ...(input.command === 'save_meeting' ? { meeting: input.input } : { managerAnswers: input.input.answers, managerNote: input.input.managerNote, summary: input.input.summary, overallRating: input.input.overallRating, ratings: input.input.ratings, managerCompletedAt: null }) };
    return { ok: true, committed: true, operationId: input.operationId, review: row };
  } }); await h.settle();
  h.change('managerNote', 'Unsaved manager evidence'); h.change('held', true);
  assert.equal(h.button('Finalise review').props.disabled, true);
  h.submit('Review meeting'); await h.settle(); assert.equal(h.calls.filter(c => c.name === 'mutatePerformanceReview').length, 0);
  h.click('Save meeting'); await h.settle();
  assert.equal(h.field('managerNote').props.value, 'Unsaved manager evidence');
  assert.equal(h.button('Finalise review').props.disabled, true);
  h.change('meeting-notes', 'Unsaved meeting evidence'); h.click('Save manager draft'); await h.settle();
  assert.equal(h.field('meeting-notes').props.value, 'Unsaved meeting evidence');
  assert.equal(h.calls.at(-1).args[0].input.managerNote, 'Unsaved manager evidence');
  h.unmount();
});

test('Admin and P0 never acquire employee writes from an incorrectly self-shaped DTO', async () => {
  for (const role of ['admin', 'system_admin']) {
    const data = workspace(); data.viewerContext.role = role; data.startablePeople = [data.reviews[0].employee];
    const h = mount(data); await h.settle();
    assert.equal(h.all.filter(n => n.type === 'form').length, 0);
    assert.ok(!h.text.includes('New yearly review'));
    assert.equal(h.calls.length, 1); h.unmount();
  }
});

test('offline browser fixture compiles the real React component and all five typed action boundaries without launching a browser', async () => {
  assert.ok(existsSync('tests/browser/performance-review-fixture.jsx'), 'Real-component browser fixture must exist');
  assert.ok(existsSync('tests/browser/performance-review.spec.mjs'), 'Browser interaction specification must exist');
  const { buildPerformanceFixture } = await import('./performance-review-offline-runner.mjs');
  const result = await buildPerformanceFixture();
  try {
    assert.deepEqual(result.typeErrors, []);
    assert.deepEqual(result.actionExports.sort(), ['getPerformanceReviewDocument','loadPerformanceReviews','mutatePerformanceReview','reconcilePerformanceReviewOperation','startPerformanceReview']);
    assert.ok(result.inputs.includes('src/components/performance-review-workspace.tsx'));
    assert.ok(result.inputs.includes('src/lib/performance-review-document.ts'));
    assert.ok(!result.inputs.includes('src/lib/supabase/client.ts'));
    assert.ok(result.outputs.some(path => path.endsWith('/performance-review.js')));
    assert.ok(result.outputs.some(path => path.endsWith('/performance-review.css')));
    assert.ok(result.outputs.some(path => path.endsWith('/index.html')));
  } finally { await rm(result.directory, { recursive: true }); }
});

test('late manager mutation cannot revive private state or release a newer employee write after reauthentication', async () => {
  const oldPending = deferred(), newer = deferred();
  const h = mount(workspace('manager'), { mutatePerformanceReview: () => oldPending.promise }); await h.settle();
  h.change('managerNote', 'PRIVATE-OLD-REQUEST'); h.click('Save manager draft'); h.render();
  const old = h.calls.at(-1).args[0]; h.auth('SIGNED_OUT');
  h.ports.loadPerformanceReviews = async () => ({ ok: true, data: workspace() }); h.auth('SIGNED_IN', ids.actor); await h.settle();
  h.ports.mutatePerformanceReview = () => newer.promise;
  h.change('self-0', 'New employee pending draft'); h.click('Save self draft'); h.render(); const current = h.calls.at(-1).args[0];
  oldPending.resolve({ ok: true, committed: true, operationId: old.operationId, review: review('manager', 'MAM', { managerNote: 'PRIVATE-LATE-OLD-REQUEST' }) }); await h.settle();
  assert.ok(!JSON.stringify(h.hooks).includes('PRIVATE-'));
  assert.equal(h.button('Save self draft').props.disabled, true);
  assert.equal(h.field('self-0').props.value, 'New employee pending draft');
  newer.resolve({ ok: true, committed: true, operationId: current.operationId, review: review('employee', 'MAM', { selfRevision: 'self:1', selfAnswers: current.input.answers }) }); await h.settle();
  assert.equal(h.button('Save self draft').props.disabled, false); h.unmount();
});

test('retired manager document responses never invoke the adapter or create a Blob after logout or unmount', async () => {
  for (const boundary of ['logout', 'unmount']) {
    const pending = deferred(), row = review('manager');
    const h = mount(workspace('manager'), { getPerformanceReviewDocument: () => pending.promise }); await h.settle();
    h.click('Download Word'); h.render();
    if (boundary === 'logout') h.auth('SIGNED_OUT'); else h.unmount();
    pending.resolve({ ok: true, document: documentFor(row) }); await h.settle();
    assert.equal(h.built.length, 0); assert.equal(h.downloads.length, 0); assert.equal(h.blobs.size, 0);
    if (boundary === 'logout') h.unmount();
  }
});

test('initial and overlapping manual reads are latest-epoch only', async () => {
  const initial = deferred(), first = deferred(), second = deferred();
  const h = mount(workspace(), { loadPerformanceReviews: () => initial.promise });
  h.ports.loadPerformanceReviews = () => first.promise; h.click('Reload'); h.render();
  h.ports.loadPerformanceReviews = () => second.promise; h.click('Reload'); h.render();
  second.resolve({ ok: true, data: workspace('employee', 'MAM', { reviews: [review('employee', 'MAM', { selfAnswers: Array(12).fill('Newest read'), selfRevision: 'self:2' })] }) }); await h.settle();
  initial.resolve({ ok: true, data: workspace() }); first.resolve({ ok: true, data: workspace() }); await h.settle();
  assert.equal(h.field('self-0').props.value, 'Newest read'); h.unmount();
});

test('unauthorised projections are rejected before reading manager fields, Account and Manager own reviews remain self-only', async () => {
  for (const role of ['employee', 'account']) {
    const data = workspace('manager'); data.viewerContext.role = role;
    for (const key of ['managerAnswers','ratings','summary','overallRating','managerNote','meeting','managerActivity']) Object.defineProperty(data.reviews[0], key, { get() { throw new Error('Denied audience must not read '+key); } });
    const h = mount(data); await h.settle(); assert.equal(h.all.filter(n => n.type === 'form').length, 0); h.unmount();
  }
  for (const role of ['account', 'manager']) {
    const data = workspace(); data.viewerContext.role = role;
    const h = mount(data, { mutatePerformanceReview: async input => ({ ok: true, committed: true, operationId: input.operationId, review: review('employee', 'MAM', { selfRevision: input.command === 'submit_self' ? 'self:2' : 'self:1', selfAnswers: input.input.answers, ...(input.command === 'submit_self' ? { selfSubmittedAt: '2026-10-01T01:00:00Z', selfStatus: 'manager_review', capabilities: { saveSelf: false, submitSelf: false, downloadDocument: true } } : {}) }) }) }); await h.settle();
    h.change('self-0', role+' own self draft'); h.click('Save self draft'); await h.settle();
    assert.equal(h.calls.at(-1).args[0].command, 'save_self'); assert.ok(!JSON.stringify(h.hooks).includes('managerNote'));
    h.submit('Self assessment'); await h.settle();
    assert.equal(h.calls.at(-1).args[0].command, 'submit_self'); assert.equal(h.calls.at(-1).args[0].expectedRevision, 'self:1');
    assert.equal(h.field('self-0').props.disabled, true); assert.ok(!JSON.stringify(h.hooks).includes('managerNote')); h.unmount();
  }
});

test('UTF-16 limit and locked direct input events never dispatch invalid writes', async () => {
  const h = mount(workspace()); await h.settle();
  h.change('self-0', '😀'.repeat(4001)); h.click('Save self draft'); await h.settle();
  assert.equal(h.calls.filter(c => c.name === 'mutatePerformanceReview').length, 0);
  assert.ok(h.text.includes('8000'));
  h.unmount();
  const hr = mount(workspace('admin')); await hr.settle();
  const original = hr.field('managerNote').props.value; hr.change('managerNote', 'Attempted HR edit'); assert.equal(hr.field('managerNote').props.value, original);
  hr.submit('Review meeting'); await hr.settle(); assert.equal(hr.calls.filter(c => c.name === 'mutatePerformanceReview').length, 0); hr.unmount();
});

test('effect replay with a transient initial failure leaves a working explicit Reload', async () => {
  for (const mode of ['typed', 'throw']) {
    const h = mount(workspace(), { loadPerformanceReviews: async () => { if (mode === 'throw') throw new Error('Synthetic unavailable'); return failure('unavailable'); } }); h.replayEffects(); await h.settle();
    assert.ok(h.text.includes(mode === 'typed' ? 'Synthetic unavailable.' : 'Reviews could not be loaded.'));
    const before = h.calls.length; h.ports.loadPerformanceReviews = async () => ({ ok: true, data: workspace() });
    h.click('Reload'); await h.settle();
    assert.equal(h.calls.length, before + 1); assert.equal(h.field('self-0').props.value, review().selfAnswers[0]); h.unmount();
  }
});

test('unknown write retains its original unchanged draft even when reload returns a newer version', async () => {
  const h = mount(workspace(), { mutatePerformanceReview: async () => failure('uncertain', true) }); await h.settle();
  const before = h.field('self-0').props.value; h.click('Save self draft'); await h.settle();
  h.ports.loadPerformanceReviews = async () => ({ ok: true, data: workspace('employee', 'MAM', { reviews: [review('employee', 'MAM', { selfRevision: 'self:9', selfAnswers: Array(12).fill('Different authoritative values') })] }) });
  h.click('Reload'); await h.settle(); assert.equal(h.field('self-0').props.value, before);
  assert.equal(h.button('Save self draft').props.disabled, true); assert.ok(!h.text.includes('Update confirmed.')); h.unmount();
});

test('review ordering uses visible cycle, due date and code and remains stable after a receipt', async () => {
  const older = review('employee', 'MAM', { id: ids.other, code: 'PR-2025-0001', cycle: '2025', dueDate: '2025-11-30' }), newer = review();
  const h = mount(workspace('employee', 'MAM', { reviews: [older, newer] }), { mutatePerformanceReview: async input => ({ ok: true, committed: true, operationId: input.operationId, review: { ...older, selfRevision: 'self:1', selfAnswers: input.input.answers } }) }); await h.settle();
  const order = () => h.all.find(n => n.type === 'nav').props.children.map(n => n.props.children[0]);
  assert.deepEqual(order(), [newer.code, older.code]);
  h.click(`${older.code} — ${older.employee.name} — ${older.cycle}`); h.render(); h.change('self-0', 'Older visible cycle update'); h.click('Save self draft'); await h.settle();
  assert.deepEqual(order(), [newer.code, older.code]); h.unmount();
});

test('same-role selected-record permission loss immediately clears forms, drafts and active Blob URLs', async () => {
  const data = workspace('manager'); data.startablePeople = [data.reviews[0].employee];
  const h = mount(data, { getPerformanceReviewDocument: async () => ({ ok: true, document: documentFor(data.reviews[0]) }) }); await h.settle();
  await h.click('Download Word'); await h.settle(); h.change('managerNote', 'PRIVATE-REVOKED-ASSIGNMENT');
  h.click('New yearly review'); h.render(); h.change('start-cycle', '2026');
  h.ports.loadPerformanceReviews = async () => ({ ok: true, data: workspace('manager', 'MAM', { reviews: [], startablePeople: [] }) }); h.click('Reload'); await h.settle();
  assert.ok(!JSON.stringify(h.hooks).includes('PRIVATE-'));
  assert.equal(h.all.filter(n => n.type === 'form').length, 0);
  assert.deepEqual(h.revoked, [h.downloads[0].href]); h.unmount();
});

test('an unresolved write prevents record reselection from discarding the held draft', async () => {
  const h = mount(workspace(), { mutatePerformanceReview: async () => failure('uncertain', true) }); await h.settle();
  h.change('self-0', 'Held draft must not be discarded by navigation'); h.click('Save self draft'); await h.settle();
  const row = review(), label = `${row.code} — ${row.employee.name} — ${row.cycle}`;
  assert.equal(h.button(label).props.disabled, true);
  h.click(label); h.render(); assert.equal(h.field('self-0').props.value, 'Held draft must not be discarded by navigation'); h.unmount();
});
