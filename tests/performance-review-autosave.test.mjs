import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './performance-review-harness.mjs';
import { workspace, review, deferred, failure, ids, ratings } from './performance-review-fixtures.mjs';

const writes = h => h.calls.filter(call => call.name === 'mutatePerformanceReview');
const tick = async (h, ms = 600) => { h.advanceTimers(ms); await h.settle(); };
const nextRevision = value => value.replace(/\d+$/, match => String(Number(match) + 1));
function committed(input, row) {
  const next = { ...row };
  if (input.command === 'save_self' || input.command === 'submit_self') {
    next.selfAnswers = [...input.input.answers]; next.selfRevision = nextRevision(input.expectedRevision);
    if (input.command === 'submit_self') { next.selfSubmittedAt = '2026-10-21T01:00:00Z'; next.selfStatus = 'manager_review'; }
  } else {
    next[row.audience === 'admin' ? 'readRevision' : 'managerRevision'] = nextRevision(input.expectedRevision);
    if (input.command === 'save_manager' || input.command === 'complete_manager') {
      Object.assign(next, { managerAnswers: [...input.input.answers], ratings: [...input.input.ratings], summary: input.input.summary, overallRating: input.input.overallRating, managerNote: input.input.managerNote });
      if (input.command === 'complete_manager') next.managerCompletedAt ??= '2026-10-21T01:00:00Z';
    } else next.meeting = { ...input.input };
  }
  return { ok: true, committed: true, operationId: input.operationId, review: next };
}
function saving(row) { let current = row; return async input => { const result = committed(input, current); current = result.review; return result; }; }
function mounted(audience = 'employee', options = {}, props = {}) {
  const row = options.row ?? review(audience);
  const data = options.data ?? workspace(audience, 'MAM', { reviews: [row] });
  return mount(data, { mutatePerformanceReview: saving(row), ...options.ports }, props);
}
const secondManagerReview = () => review('manager', 'MAM', { id: ids.other, code: 'PR-2026-0002', employee: { ...review().employee, id: '22000000-0000-4000-8000-000000000099', name: 'Second synthetic colleague' } });

test('untouched drafts and effect replay do not autosave', async () => {
  const h = mounted();
  try { await h.settle(); h.replayEffects(); await h.settle(); await tick(h, 2000); assert.equal(writes(h).length, 0); }
  finally { h.unmount(); }
});

test('self answers debounce for 600ms and save only the newest full draft without submission', async () => {
  const h = mounted();
  try {
    await h.settle();
    for (let i = 0; i < 12; i++) h.change(`self-${i}`, `Synthetic self draft ${i}`);
    await tick(h, 599); assert.equal(writes(h).length, 0);
    h.change('self-0', 'Newest self answer'); await tick(h, 599); assert.equal(writes(h).length, 0);
    await tick(h, 1); assert.equal(writes(h).length, 1);
    const input = writes(h)[0].args[0];
    assert.equal(input.command, 'save_self'); assert.equal(input.expectedRevision, 'self:0');
    assert.deepEqual(input.input.answers, ['Newest self answer', ...Array.from({ length: 11 }, (_, i) => `Synthetic self draft ${i + 1}`)]);
    assert.ok(!h.text.includes('Self assessment submitted')); await tick(h, 2000); assert.equal(writes(h).length, 1);
  } finally { h.unmount(); }
});

test('manager answers, ratings, summary, overall rating and private note autosave without inviting', async () => {
  const h = mounted('manager');
  try {
    await h.settle();
    for (let i = 0; i < 12; i++) h.change(`manager-${i}`, `Synthetic manager draft ${i}`);
    for (const i of [0, 1, 2, 6, 7, 8, 9]) h.change(`rating-${i}`, ratings[2]);
    h.change('summary', 'Newest synthetic summary'); h.change('overallRating', ratings[0]); h.change('managerNote', 'PRIVATE-AUTOSAVE-NOTE');
    await tick(h);
    const input = writes(h)[0].args[0]; assert.equal(writes(h).length, 1); assert.equal(input.command, 'save_manager');
    assert.equal(input.expectedRevision, 'manager:0:0'); assert.deepEqual(input.input.answers, Array.from({ length: 12 }, (_, i) => `Synthetic manager draft ${i}`));
    for (const i of [0, 1, 2, 6, 7, 8, 9]) assert.equal(input.input.ratings[i], ratings[2]);
    assert.equal(input.input.summary, 'Newest synthetic summary'); assert.equal(input.input.overallRating, ratings[0]); assert.equal(input.input.managerNote, 'PRIVATE-AUTOSAVE-NOTE');
    assert.ok(h.button('Save draft and invite meeting')); assert.equal(h.invitationStatusCalls.length, 0);
  } finally { h.unmount(); }
});

for (const audience of ['employee', 'manager']) test(`${audience} reload recovers the confirmed draft through a fresh authorised workspace load`, async () => {
  let stored = review(audience);
  const ports = {
    loadPerformanceReviews: async () => ({ ok: true, data: workspace(audience, 'MAM', { reviews: [stored] }) }),
    mutatePerformanceReview: async input => { const receipt = committed(input, stored); stored = receipt.review; return receipt; },
  };
  const field = audience === 'employee' ? 'self-0' : 'managerNote';
  const h = mounted(audience, { ports });
  try { await h.settle(); h.change(field, 'Synthetic draft retained after reload'); await tick(h); assert.equal(h.beforeUnload().prevented, false); }
  finally { h.unmount(); }
  const fresh = mounted(audience, { ports });
  try {
    await fresh.settle(); assert.equal(fresh.field(field).props.value, 'Synthetic draft retained after reload');
    assert.equal(writes(fresh).length, 0); assert.equal(fresh.beforeUnload().prevented, false);
  } finally { fresh.unmount(); }
});

for (const audience of ['employee', 'manager']) test(`${audience} keeps inputs editable and serially drains edits made during an autosave`, async () => {
  const row = review(audience), pending = deferred(); let attempt = 0;
  const h = mounted(audience, { ports: { mutatePerformanceReview: input => ++attempt === 1 ? pending.promise : Promise.resolve(committed(input, row)) } });
  try {
    await h.settle(); const field = audience === 'employee' ? 'self-0' : 'managerNote';
    h.change(field, 'Snapshot sent first'); await tick(h); assert.equal(writes(h).length, 1);
    assert.equal(h.field(field).props.disabled, false); h.change(field, 'Newest edit while saving');
    await tick(h); assert.equal(writes(h).length, 1, 'One unresolved mutation at a time');
    pending.resolve(committed(writes(h)[0].args[0], row)); await h.settle();
    assert.equal(h.field(field).props.value, 'Newest edit while saving'); await tick(h);
    assert.equal(writes(h).length, 2); const input = writes(h)[1].args[0];
    assert.equal(input.expectedRevision, audience === 'employee' ? 'self:1' : 'manager:0:1');
    assert.equal(audience === 'employee' ? input.input.answers[0] : input.input.managerNote, 'Newest edit while saving');
    assert.notEqual(input.operationId, writes(h)[0].args[0].operationId);
  } finally { h.unmount(); }
});

for (const [audience, field, form, command] of [['employee', 'self-0', 'Self assessment', 'save_self'], ['manager', 'managerNote', 'Manager assessment', 'save_manager']]) test(`${audience} blur flushes the pending debounce once`, async () => {
  const h = mounted(audience);
  try { await h.settle(); h.change(field, 'Draft flushed on blur'); h.blur(form); await h.settle(); assert.deepEqual(writes(h).map(call => call.args[0].command), [command]); await tick(h, 1200); assert.equal(writes(h).length, 1); }
  finally { h.unmount(); }
});

test('selecting another employee flushes the old draft before switching and does not mix review IDs', async () => {
  const a = review('manager'), b = secondManagerReview(), pending = deferred();
  const h = mounted('manager', { data: workspace('manager', 'MAM', { reviews: [a, b] }), ports: { mutatePerformanceReview: () => pending.promise } });
  try {
    await h.settle(); h.change('managerNote', 'PRIVATE-FIRST-REVIEW'); h.click(`${b.employee.name} — MAM`); await h.settle();
    assert.equal(writes(h).length, 1); const input = writes(h)[0].args[0]; assert.equal(input.reviewId, a.id); assert.equal(input.input.managerNote, 'PRIVATE-FIRST-REVIEW');
    assert.equal(h.field('managerNote').props.value, 'PRIVATE-FIRST-REVIEW'); pending.resolve(committed(input, a)); await h.settle();
    assert.equal(h.field('managerNote').props.value, b.managerNote); assert.ok(h.text.includes(b.employee.name));
    await tick(h); assert.equal(writes(h).length, 1);
  } finally { h.unmount(); }
});

test('cycle selection saves the current year before opening the other review', async () => {
  const a = review('employee'), b = review('employee', 'MAM', { id: ids.other, cycle: '2025', code: 'PR-2025-0001', selfAnswers: Array(12).fill('Historical synthetic answer') });
  const h = mounted('employee', { data: workspace('employee', 'MAM', { reviews: [a, b] }) });
  try {
    await h.settle(); h.change('self-0', 'Current year draft'); h.change('start-cycle', '2025'); await h.settle();
    assert.equal(writes(h).length, 1); assert.equal(writes(h)[0].args[0].reviewId, a.id); assert.equal(writes(h)[0].args[0].command, 'save_self');
    assert.equal(h.field('self-0').props.value, 'Historical synthetic answer'); await tick(h); assert.equal(writes(h).length, 1);
  } finally { h.unmount(); }
});

test('explicit self submission waits for the active autosave and uses the latest draft and receipt revision', async () => {
  const row = review(), pending = deferred(); let attempt = 0;
  const h = mounted('employee', { ports: { mutatePerformanceReview: input => ++attempt === 1 ? pending.promise : Promise.resolve(committed(input, row)) } });
  try {
    await h.settle(); h.change('self-0', 'First snapshot'); await tick(h); h.change('self-0', 'Latest explicit submission'); h.submit('Self assessment'); await h.settle();
    assert.equal(writes(h).length, 1); pending.resolve(committed(writes(h)[0].args[0], row)); await h.settle(); await tick(h);
    const calls = writes(h).map(call => call.args[0]); assert.equal(calls.at(-1).command, 'submit_self'); assert.equal(calls.at(-1).input.answers[0], 'Latest explicit submission');
    assert.equal(calls.filter(input => input.command === 'submit_self').length, 1); assert.notEqual(calls.at(-1).expectedRevision, 'self:0');
    assert.ok(h.text.includes('Self assessment submitted'));
  } finally { h.unmount(); }
});

test('an explicit meeting invitation waits for background manager saving and includes the newest draft once', async () => {
  const row = review('manager'), pending = deferred(); let attempt = 0;
  const h = mounted('manager', { ports: { mutatePerformanceReview: input => ++attempt === 1 ? pending.promise : Promise.resolve(committed(input, row)) } });
  try {
    await h.settle(); h.change('managerNote', 'First manager snapshot'); await tick(h);
    h.change('managerNote', 'Latest manager invitation draft'); h.click('Save draft and invite meeting'); await h.settle(); assert.equal(writes(h).length, 1);
    pending.resolve(committed(writes(h)[0].args[0], row)); await h.settle(); await tick(h);
    const calls = writes(h).map(call => call.args[0]); assert.equal(calls.at(-1).command, 'complete_manager'); assert.equal(calls.at(-1).input.managerNote, 'Latest manager invitation draft');
    assert.equal(calls.filter(input => input.command === 'complete_manager').length, 1); assert.notEqual(calls.at(-1).expectedRevision, 'manager:0:0');
  } finally { h.unmount(); }
});

test('a field blur keeps the invitation clickable while its draft saves', async () => {
  const row = review('manager'), pending = deferred(); let attempt = 0;
  const h = mounted('manager', { ports: { mutatePerformanceReview: input => ++attempt === 1 ? pending.promise : Promise.resolve(committed(input, row)) } });
  try {
    await h.settle(); h.change('managerNote', 'Blurred invitation draft'); h.blur('Manager assessment'); h.render();
    assert.equal(h.button('Save draft and invite meeting').props.disabled, false);
    h.click('Save draft and invite meeting'); pending.resolve(committed(writes(h)[0].args[0], row)); await h.settle();
    assert.deepEqual(writes(h).map(call => call.args[0].command), ['save_manager', 'complete_manager']);
  } finally { h.unmount(); }
});

test('queued HR submission rechecks the current meeting-held confirmation after autosave', async () => {
  const row = review('manager', 'MAM', { managerCompletedAt: '2026-10-01T01:00:00Z', meeting: { date: '2026-10-01', time: '10:00', duration: 30, mode: 'in_person', location: 'Synthetic room', notes: '' } });
  const pending = deferred();
  const h = mounted('manager', { row, ports: { mutatePerformanceReview: () => pending.promise } });
  try {
    await h.settle(); h.change('held', true); h.change('managerNote', 'Queued HR draft'); await tick(h);
    assert.equal(h.button('Save and send final review').props.disabled, false);
    h.submit('Review meeting'); h.change('held', false);
    pending.resolve(committed(writes(h)[0].args[0], row)); await h.settle();
    assert.deepEqual(writes(h).map(call => call.args[0].command), ['save_manager']);
    assert.equal(h.field('held').props.checked, false);
  } finally { h.unmount(); }
});

test('manager assessment and meeting autosaves preserve sibling drafts and serialize their shared revision', async () => {
  const row = review('manager', 'MAM', { managerCompletedAt: '2026-10-01T01:00:00Z', meeting: { date: '2026-10-01', time: '10:00', duration: 30, mode: 'in_person', location: 'Synthetic room', notes: '' } });
  const h = mounted('manager', { row });
  try {
    await h.settle(); h.change('managerNote', 'PRIVATE-LATEST-ASSESSMENT'); h.change('meeting-notes', 'Latest meeting draft'); await tick(h); await tick(h);
    const calls = writes(h).map(call => call.args[0]); assert.deepEqual(calls.map(input => input.command).sort(), ['save_manager', 'save_meeting']);
    assert.equal(calls[1].expectedRevision, 'manager:0:1'); assert.equal(h.field('managerNote').props.value, 'PRIVATE-LATEST-ASSESSMENT'); assert.equal(h.field('meeting-notes').props.value, 'Latest meeting draft');
    assert.equal(calls.find(input => input.command === 'save_manager').input.managerNote, 'PRIVATE-LATEST-ASSESSMENT'); assert.equal(calls.find(input => input.command === 'save_meeting').input.notes, 'Latest meeting draft');
  } finally { h.unmount(); }
});

for (const mode of ['unavailable', 'conflict', 'uncertain', 'throw', 'bad-receipt']) test(`${mode} autosave retains the draft and does not silently retry`, async () => {
  const h = mounted('manager', { ports: { mutatePerformanceReview: async input => {
    if (mode === 'throw') throw Error('SYNTHETIC-PRIVATE-PROVIDER');
    if (mode === 'bad-receipt') return { ...committed(input, review('manager')), operationId: 'mismatched' };
    return failure(mode, mode === 'uncertain');
  } } });
  try {
    await h.settle(); h.change('managerNote', 'PRIVATE-FAILED-DRAFT'); await tick(h); assert.equal(writes(h).length, 1);
    await tick(h, 60000); h.focus(); await h.settle(); assert.equal(writes(h).length, 1); assert.equal(h.field('managerNote').props.value, 'PRIVATE-FAILED-DRAFT');
    assert.ok(!h.text.includes('SYNTHETIC-PRIVATE-PROVIDER'));
    if (['uncertain', 'throw', 'bad-receipt'].includes(mode)) { h.click('Save draft and invite meeting'); await h.settle(); assert.equal(writes(h).length, 1); assert.ok(h.button('Reconcile update')); }
  } finally { h.unmount(); }
});

for (const retirement of ['signout', 'unmount', 'delegate']) test(`queued autosave cannot cross ${retirement}`, async () => {
  const delegate = retirement === 'delegate', h = mounted('manager', {}, delegate ? { previewPersonId: ids.manager } : {});
  try {
    await h.settle(); h.change('managerNote', 'PRIVATE-RETIRED-AUTOSAVE');
    if (retirement === 'signout') h.auth('SIGNED_OUT');
    if (retirement === 'unmount') h.unmount();
    if (delegate) { h.ports.loadPerformanceReviews = async () => ({ ok: true, data: workspace('manager', 'MAM', { viewerContext: { ...workspace('manager').viewerContext, personId: ids.person }, reviews: [] }) }); h.setProps({ previewPersonId: ids.person }); await h.settle(); }
    await tick(h); assert.equal(writes(h).length, 0);
    if (retirement !== 'unmount') assert.ok(!JSON.stringify(h.hooks).includes('PRIVATE-RETIRED-AUTOSAVE'));
  } finally { h.unmount(); }
});

for (const terminal of [false, true]) test(`${terminal ? 'finalised review' : 'revoked capabilities'} cancels queued manager autosave`, async () => {
  const h = mounted('manager');
  try {
    await h.settle(); h.change('managerNote', 'PRIVATE-LOCKED-DRAFT');
    const row = review('manager', 'MAM', terminal ? { finalisedAt: '2026-10-21T01:00:00Z' } : { capabilities: { ...review('manager').capabilities, saveManager: false, completeManager: false, saveMeeting: false, submitReview: false } });
    h.ports.loadPerformanceReviews = async () => ({ ok: true, data: workspace('manager', 'MAM', { reviews: [row] }) }); h.auth('TOKEN_REFRESHED', ids.actor); await h.settle();
    await tick(h); assert.equal(writes(h).length, 0); assert.equal(h.field('managerNote').props.disabled, true);
  } finally { h.unmount(); }
});

test('a late retired autosave receipt cannot overwrite a new actor draft or release its pending write', async () => {
  const old = deferred(), current = deferred(); let attempt = 0;
  const h = mounted('manager', { ports: { mutatePerformanceReview: () => ++attempt === 1 ? old.promise : current.promise } });
  try {
    await h.settle(); h.change('managerNote', 'PRIVATE-OLD-AUTOSAVE'); await tick(h); const oldInput = writes(h)[0].args[0];
    h.auth('SIGNED_OUT'); const actor = '11000000-0000-4000-8000-000000000099';
    h.ports.loadPerformanceReviews = async () => ({ ok: true, data: workspace('employee', 'MAM', { viewerContext: { ...workspace().viewerContext, actorUserId: actor } }) });
    h.auth('SIGNED_IN', actor); await h.settle(); h.change('self-0', 'Current actor draft'); await tick(h); assert.equal(writes(h).length, 2);
    old.resolve(committed(oldInput, review('manager'))); await h.settle(); assert.equal(h.field('self-0').props.value, 'Current actor draft');
    assert.ok(!JSON.stringify(h.hooks).includes('PRIVATE-OLD-AUTOSAVE')); await tick(h); assert.equal(writes(h).length, 2);
    current.resolve(committed(writes(h)[1].args[0], review())); await h.settle(); assert.equal(h.field('self-0').props.value, 'Current actor draft');
  } finally { h.unmount(); }
});

test('valid meeting notes autosave separately while partial meeting fields remain local and unsaved', async () => {
  const meeting = { date: '2026-10-01', time: '10:00', duration: 30, mode: 'in_person', location: 'Synthetic room', notes: '' };
  const h = mounted('manager', { row: review('manager', 'MAM', { managerCompletedAt: '2026-10-01T01:00:00Z', meeting }) });
  try {
    await h.settle(); h.change('meeting-notes', 'Synthetic meeting draft'); await tick(h);
    assert.equal(writes(h).length, 1); assert.equal(writes(h)[0].args[0].command, 'save_meeting'); assert.equal(writes(h)[0].args[0].input.notes, 'Synthetic meeting draft');
    assert.ok(!Object.hasOwn(writes(h)[0].args[0].input, 'held'));
    h.change('meeting-date', ''); h.change('meeting-notes', 'Incomplete local meeting'); await tick(h); h.blur(); await h.settle();
    assert.equal(writes(h).length, 1); assert.equal(h.field('meeting-notes').props.value, 'Incomplete local meeting'); assert.equal(h.beforeUnload().prevented, true);
  } finally { h.unmount(); }
});

test('page hidden flushes drafts and beforeunload warns until a matching save receipt', async () => {
  const row = review(), pending = deferred(), h = mounted('employee', { ports: { mutatePerformanceReview: () => pending.promise } });
  try {
    await h.settle(); assert.equal(h.beforeUnload().prevented, false); h.change('self-0', 'Synthetic departure draft'); assert.equal(h.beforeUnload().prevented, true);
    h.pageHidden(); await h.settle(); assert.equal(writes(h).length, 1); assert.equal(writes(h)[0].args[0].command, 'save_self'); assert.equal(h.beforeUnload().prevented, true);
    pending.resolve(committed(writes(h)[0].args[0], row)); await h.settle(); assert.equal(h.beforeUnload().prevented, false);
    await tick(h); assert.equal(writes(h).length, 1);
  } finally { h.unmount(); }
});
