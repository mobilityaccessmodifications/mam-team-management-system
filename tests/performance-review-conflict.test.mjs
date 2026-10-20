import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './performance-review-harness.mjs';
import { workspace, review, failure, deferred, ids } from './performance-review-fixtures.mjs';

const refresh = h => { const button = h.all.find(node => node.type === 'button' && node.props.children === 'Reload'); return button ? button.props.onClick() : h.auth('TOKEN_REFRESHED', ids.actor); };
const writes = h => h.calls.filter(call => call.name === 'mutatePerformanceReview');
const settings = audience => audience === 'employee'
  ? { field: 'self-0', save: 'Save self draft', command: 'save_self', token: 'self:1' }
  : { field: 'manager-0', save: 'Save draft and invite meeting', command: 'complete_manager', token: 'manager:0:1' };
const updated = audience => review(audience, 'MAM', audience === 'employee'
  ? { selfRevision: 'self:1', selfAnswers: Array(12).fill('Authoritative other-tab answer') }
  : { managerRevision: 'manager:0:1', managerAnswers: Array(12).fill('Authoritative other-tab feedback') });

for (const audience of ['employee', 'manager']) test(`AM-04 ${audience} conflict Reload preserves the full draft and explicitly saves with the new revision`, async () => {
  const config = settings(audience), fresh = updated(audience);
  let attempt = 0;
  const h = mount(workspace(audience), { mutatePerformanceReview: async input => {
    if (++attempt === 1 || input.expectedRevision !== config.token) return failure('conflict');
    return { ok: true, committed: true, operationId: input.operationId, review: {
      ...fresh, ...(audience === 'employee' ? { selfAnswers: input.input.answers, selfRevision: 'self:2' }
        : { managerAnswers: input.input.answers, ratings: input.input.ratings, summary: input.input.summary,
          overallRating: input.input.overallRating, managerNote: input.input.managerNote, managerRevision: 'manager:0:2' }),
    } };
  } });
  try {
    await h.settle();
    h.change(config.field, 'Local synthetic conflict draft');
    if (audience === 'manager') {
      h.change('rating-0', '3 Exceeds expectations'); h.change('summary', 'Local summary');
      h.change('overallRating', '1 Needs improvement'); h.change('managerNote', 'PRIVATE-LOCAL-NOTE');
      h.change('meeting-date', '2026-10-16'); h.change('meeting-time', '09:30');
      h.change('meeting-notes', 'Local meeting draft'); h.change('held', true);
    }
    h.click(config.save); await h.settle();
    assert.ok(h.text.includes('Synthetic conflict.'));
    const first = writes(h)[0].args[0];
    h.ports.loadPerformanceReviews = async () => ({ ok: true, data: workspace(audience, 'MAM', { reviews: [fresh] }) });
    refresh(h); await h.settle();
    assert.equal(h.field(config.field).props.value, 'Local synthetic conflict draft');
    assert.equal(writes(h).length, 1, 'Reload must not replay a write');
    if (audience === 'manager') {
      assert.equal(h.field('managerNote').props.value, 'PRIVATE-LOCAL-NOTE');
      assert.equal(h.field('meeting-notes').props.value, 'Local meeting draft');
      assert.equal(h.field('held').props.checked, true);
      assert.equal(h.button('Save and send to HR').props.disabled, true);
    }
    h.click(config.save); await h.settle();
    assert.equal(writes(h).length, 2);
    const second = writes(h)[1].args[0];
    assert.equal(second.expectedRevision, config.token);
    assert.notEqual(second.operationId, first.operationId);
    assert.equal(second.command, config.command);
    assert.deepEqual(second.input, first.input, 'Recovery must not merge or replace draft fields');
    assert.ok(h.text.includes('Saved.'), 'Explicit current-revision save must complete');
    assert.equal(h.field(config.field).props.value, 'Local synthetic conflict draft');
    if (audience === 'manager') assert.equal(h.field('meeting-notes').props.value, 'Local meeting draft');
  } finally { h.unmount(); }
});

for (const audience of ['employee', 'manager']) test(`AM-04 ${audience} terminal or capability-revoked reload cannot rebase or submit the retained draft`, async () => {
  for (const kind of ['terminal', 'capability']) {
    const config = settings(audience), initial = workspace(audience);
    const h = mount(initial, { mutatePerformanceReview: async () => failure('conflict') });
    try {
      await h.settle(); h.change(config.field, 'Retained read-only conflict draft');
      const retired = h.button(config.save).props.onClick;
      h.click(config.save); await h.settle();
      const fresh = updated(audience);
      if (kind === 'terminal') {
        if (audience === 'employee') { fresh.selfSubmittedAt = '2026-10-16T01:00:00Z'; fresh.selfStatus = 'manager_review'; }
        else fresh.finalisedAt = '2026-10-16T01:00:00Z';
      } else fresh.capabilities = { ...fresh.capabilities, ...(audience === 'employee'
        ? { saveSelf: false, submitSelf: false } : { saveManager: false, completeManager: false, saveMeeting: false, submitReview: false }) };
      h.ports.loadPerformanceReviews = async () => ({ ok: true, data: workspace(audience, 'MAM', { reviews: [fresh] }) });
      refresh(h); await h.settle();
      assert.equal(h.field(config.field).props.value, 'Retained read-only conflict draft');
      assert.equal(h.field(config.field).props.disabled, true);
      retired(); h.click(config.save); h.submit(audience === 'employee' ? 'Self assessment' : 'Manager assessment');
      if (audience === 'manager') { h.blur(); h.submit('Review meeting'); }
      await h.settle(); assert.equal(writes(h).length, 1);
      h.ports.loadPerformanceReviews = async () => ({ ok: true, data: workspace(audience, 'MAM', { reviews: [updated(audience)] }) });
      refresh(h); await h.settle(); h.click(config.save); await h.settle();
      assert.equal(writes(h)[1].args[0].expectedRevision, audience === 'employee' ? 'self:0' : 'manager:0:0', 'Noneditable read must not refresh the conflict token');
    } finally { h.unmount(); }
  }
});

for (const audience of ['employee', 'manager']) test(`AM-04 ${audience} only the newest explicit conflict Reload may refresh the draft revision`, async () => {
  const config = settings(audience), first = deferred(), second = deferred();
  const h = mount(workspace(audience), { mutatePerformanceReview: async () => failure('conflict') });
  try {
    await h.settle(); h.change(config.field, 'Draft before overlapping reloads'); h.click(config.save); await h.settle();
    h.ports.loadPerformanceReviews = () => first.promise; refresh(h); h.render();
    const obsolete = h.button('Reload').props.onClick;
    h.ports.loadPerformanceReviews = () => second.promise; refresh(h); h.render();
    h.change(config.field, 'Newest draft edited during reload');
    const fresh = { ...updated(audience), ...(audience === 'employee' ? { selfRevision: 'self:2' } : { managerRevision: 'manager:0:2' }) };
    second.resolve({ ok: true, data: workspace(audience, 'MAM', { reviews: [fresh] }) }); await h.settle();
    first.resolve({ ok: true, data: workspace(audience, 'MAM', { reviews: [updated(audience)] }) }); await h.settle();
    const reads = h.calls.length; obsolete(); await h.settle(); assert.equal(h.calls.length, reads);
    assert.equal(h.field(config.field).props.value, 'Newest draft edited during reload');
    assert.equal(writes(h).length, 1);
    h.click(config.save); await h.settle();
    assert.equal(writes(h)[1].args[0].expectedRevision, audience === 'employee' ? 'self:2' : 'manager:0:2');
    assert.equal(writes(h)[1].args[0].input.answers[0], 'Newest draft edited during reload');
  } finally { h.unmount(); }
});

for (const audience of ['employee', 'manager']) test(`AM-04 ${audience} ordinary dirty reload and rejected nonconflict save do not silently rebase`, async () => {
  for (const code of [null, 'invalid', 'unavailable']) {
    const config = settings(audience), h = mount(workspace(audience), { mutatePerformanceReview: async () => failure(code ?? 'conflict') });
    try {
      await h.settle(); h.change(config.field, 'Ordinary local draft');
      if (code) { h.click(config.save); await h.settle(); }
      h.ports.loadPerformanceReviews = async () => ({ ok: true, data: workspace(audience, 'MAM', { reviews: [updated(audience)] }) });
      refresh(h); await h.settle(); h.click(config.save); await h.settle();
      assert.equal(writes(h).at(-1).args[0].expectedRevision, audience === 'employee' ? 'self:0' : 'manager:0:0');
      assert.equal(h.field(config.field).props.value, 'Ordinary local draft');
    } finally { h.unmount(); }
  }
});

for (const audience of ['employee', 'manager']) test(`AM-04 ${audience} an unknown attempt after a conflict remains reconciliation-only`, async () => {
  for (const mode of ['uncertain', 'conflict-with-uncertain', 'throw', 'bad-receipt']) {
    const config = settings(audience), h = mount(workspace(audience), { mutatePerformanceReview: async () => failure('conflict') });
    try {
      await h.settle(); h.change(config.field, 'Unknown held conflict draft'); h.click(config.save); await h.settle();
      h.ports.mutatePerformanceReview = async () => {
        if (mode === 'throw') throw new Error('Synthetic transport failure');
        if (mode === 'bad-receipt') return { ok: true, committed: true, operationId: 'wrong', review: updated(audience) };
        return failure(mode === 'conflict-with-uncertain' ? 'conflict' : 'uncertain', true);
      };
      h.click(config.save); await h.settle();
      const pending = writes(h)[1].args[0];
      h.ports.loadPerformanceReviews = async () => ({ ok: true, data: workspace(audience, 'MAM', { reviews: [updated(audience)] }) });
      refresh(h); await h.settle();
      assert.equal(h.field(config.field).props.value, 'Unknown held conflict draft');
      assert.equal(h.button(config.save).props.disabled, true);
      h.click(config.save); h.submit(audience === 'employee' ? 'Self assessment' : 'Manager assessment'); await h.settle();
      assert.equal(writes(h).length, 2);
      h.ports.reconcilePerformanceReviewOperation = async () => ({ ok: true, data: { status: 'not_found', review: null } });
      h.click('Reconcile update'); await h.settle();
      assert.deepEqual(h.calls.at(-1).args[0], { operationId: pending.operationId, reviewId: pending.reviewId });
      assert.equal(h.button(config.save).props.disabled, true);
      assert.equal(writes(h).length, 2);
      h.ports.reconcilePerformanceReviewOperation = async () => ({ ok: true, data: { status: 'committed', review: updated(audience) } });
      h.click('Reconcile update'); await h.settle();
      assert.ok(h.text.includes('Update confirmed.')); assert.equal(writes(h).length, 2);
    } finally { h.unmount(); }
  }
});

for (const audience of ['employee', 'manager']) test(`AM-04 ${audience} a failed conflict Reload can be retried without losing the recovery scope`, async () => {
  for (const mode of ['typed', 'throw']) {
    const config = settings(audience), h = mount(workspace(audience), { mutatePerformanceReview: async () => failure('conflict') });
    try {
      await h.settle(); h.change(config.field, 'Draft retained through failed reload'); h.click(config.save); await h.settle();
      h.ports.loadPerformanceReviews = async () => { if (mode === 'throw') throw new Error('Synthetic offline'); return failure('unavailable'); };
      refresh(h); await h.settle(); assert.equal(writes(h).length, 1);
      assert.equal(h.field(config.field).props.value, 'Draft retained through failed reload');
      h.ports.loadPerformanceReviews = async () => ({ ok: true, data: workspace(audience, 'MAM', { reviews: [updated(audience)] }) });
      refresh(h); await h.settle(); h.click(config.save); await h.settle();
      assert.equal(writes(h)[1].args[0].expectedRevision, config.token);
    } finally { h.unmount(); }
  }
});

for (const audience of ['employee', 'manager']) test(`AM-04 ${audience} unchanged draft is preserved on confirmed conflict Reload`, async () => {
  const config = settings(audience), h = mount(workspace(audience), { mutatePerformanceReview: async () => failure('conflict') });
  try {
    await h.settle(); const original = h.field(config.field).props.value;
    h.click(config.save); await h.settle();
    h.ports.loadPerformanceReviews = async () => ({ ok: true, data: workspace(audience, 'MAM', { reviews: [updated(audience)] }) });
    refresh(h); await h.settle();
    assert.equal(h.field(config.field).props.value, original);
    h.click(config.save); await h.settle(); assert.equal(writes(h)[1].args[0].expectedRevision, config.token);
    assert.deepEqual(writes(h)[1].args[0].input, writes(h)[0].args[0].input);
  } finally { h.unmount(); }
});

for (const scope of ['role', 'person', 'actor', 'audience', 'missing-review']) test(`AM-04 conflict Reload clears private drafts when ${scope} scope changes`, async () => {
  const h = mount(workspace('manager'), { mutatePerformanceReview: async () => failure('conflict') });
  try {
    await h.settle(); h.change('managerNote', 'PRIVATE-RETIRED-CONFLICT'); h.click('Save draft and invite meeting'); await h.settle();
    const retired = h.button('Save draft and invite meeting').props.onClick;
    let data = workspace('manager');
    if (scope === 'role') data = workspace('admin');
    if (scope === 'person') data = workspace('manager', 'MAM', { viewerContext: { ...data.viewerContext, personId: ids.person }, reviews: [] });
    if (scope === 'actor') data.viewerContext.actorUserId = '11000000-0000-4000-8000-000000000099';
    if (scope === 'audience') data.reviews = [review('employee', 'MAM', { employee: { ...review().employee, id: ids.manager } })];
    if (scope === 'missing-review') data.reviews = [];
    h.ports.loadPerformanceReviews = async () => ({ ok: true, data });
    refresh(h); await h.settle();
    assert.ok(!JSON.stringify(h.hooks).includes('PRIVATE-RETIRED-CONFLICT'));
    retired(); await h.settle(); assert.equal(writes(h).length, 1);
    if (scope === 'role') assert.equal(h.field('managerNote').props.disabled, true);
  } finally { h.unmount(); }
});

test('AM-04 conflict recovery is retired by review selection A to B to A', async () => {
  const a = review('manager'), b = review('manager', 'MAM', { id: ids.other, code: 'PR-2026-0002', employee: { ...a.employee, id: '22000000-0000-4000-8000-000000000099', name: 'Synthetic B colleague' } });
  const h = mount(workspace('manager', 'MAM', { reviews: [a, b] }), { mutatePerformanceReview: async () => failure('conflict') });
  try {
    await h.settle(); h.change('managerNote', 'PRIVATE-OLD-A-CONFLICT'); h.click('Save draft and invite meeting'); await h.settle();
    const pending = deferred(); h.ports.loadPerformanceReviews = () => pending.promise; refresh(h); h.render();
    for (const row of [b, a]) { h.click(`${row.employee.name} — ${row.employee.company}`); h.render(); }
    h.change('managerNote', 'PRIVATE-NEW-A-DRAFT');
    pending.resolve({ ok: true, data: workspace('manager', 'MAM', { reviews: [updated('manager'), b] }) }); await h.settle();
    assert.equal(h.field('managerNote').props.value, 'PRIVATE-NEW-A-DRAFT');
    h.ports.loadPerformanceReviews = async () => ({ ok: true, data: workspace('manager', 'MAM', { reviews: [updated('manager'), b] }) });
    refresh(h); await h.settle(); h.click('Save draft and invite meeting'); await h.settle();
    assert.equal(writes(h)[1].args[0].expectedRevision, 'manager:0:0');
    assert.equal(writes(h)[1].args[0].input.managerNote, 'PRIVATE-NEW-A-DRAFT');
  } finally { h.unmount(); }
});

test('AM-04 same-actor token refresh never automatically rebases but retains explicit conflict recovery', async () => {
  const h = mount(workspace(), { mutatePerformanceReview: async () => failure('conflict') });
  try {
    await h.settle(); h.change('self-0', 'Draft across token refresh'); h.click('Save self draft'); await h.settle();
    h.ports.loadPerformanceReviews = async () => ({ ok: true, data: workspace('employee', 'MAM', { reviews: [updated('employee')] }) });
    h.auth('TOKEN_REFRESHED', ids.actor); await h.settle();
    assert.equal(writes(h).length, 1); assert.equal(h.field('self-0').props.value, 'Draft across token refresh');
    h.click('Save self draft'); await h.settle(); assert.equal(writes(h)[1].args[0].expectedRevision, 'self:0');
    refresh(h); await h.settle(); h.click('Save self draft'); await h.settle();
    assert.equal(writes(h)[2].args[0].expectedRevision, 'self:1');
  } finally { h.unmount(); }
});

test('AM-04 logout and actor A to B to A retire conflict reloads and all private state', async () => {
  const h = mount(workspace('manager'), { mutatePerformanceReview: async () => failure('conflict') });
  try {
    await h.settle(); h.change('managerNote', 'PRIVATE-OLD-SESSION-CONFLICT'); h.click('Save draft and invite meeting'); await h.settle();
    const pending = deferred(); h.ports.loadPerformanceReviews = () => pending.promise; refresh(h); h.render();
    const retired = h.button('Save draft and invite meeting').props.onClick;
    h.auth('SIGNED_OUT'); assert.ok(!JSON.stringify(h.hooks).includes('PRIVATE-'));
    const actorB = '11000000-0000-4000-8000-000000000099';
    h.ports.loadPerformanceReviews = async () => ({ ok: true, data: workspace('employee', 'MAM', { viewerContext: { ...workspace().viewerContext, actorUserId: actorB } }) });
    h.auth('SIGNED_IN', actorB); await h.settle();
    h.ports.loadPerformanceReviews = async () => ({ ok: true, data: workspace('manager') });
    h.auth('SIGNED_IN', ids.actor); await h.settle(); h.change('managerNote', 'New synthetic session draft');
    pending.resolve({ ok: true, data: workspace('manager', 'MAM', { reviews: [updated('manager')] }) }); await h.settle();
    retired(); await h.settle(); assert.equal(writes(h).length, 1);
    refresh(h); await h.settle(); h.click('Save draft and invite meeting'); await h.settle();
    assert.equal(writes(h)[1].args[0].expectedRevision, 'manager:0:0');
    assert.equal(writes(h)[1].args[0].input.managerNote, 'New synthetic session draft');
  } finally { h.unmount(); }
});

for (const command of ['submit_self', 'complete_manager', 'submit_review']) test(`AM-04 ${command} conflict recovery needs a second explicit submission with the refreshed token`, async () => {
  const audience = command === 'submit_self' ? 'employee' : 'manager';
  const form = command === 'submit_self' ? 'Self assessment' : command === 'complete_manager' ? 'Manager assessment' : 'Review meeting';
  const initial = workspace(audience), fresh = updated(audience);
  if (command === 'submit_review') {
    initial.reviews[0].managerCompletedAt = '2026-10-16T00:00:00Z';
    fresh.managerCompletedAt = initial.reviews[0].managerCompletedAt;
  }
  let attempt = 0;
  const h = mount(initial, { mutatePerformanceReview: async input => {
    if (++attempt === 1) return failure('conflict');
    return { ok: true, committed: true, operationId: input.operationId, review: { ...fresh,
      ...(command === 'submit_self' ? { selfAnswers: input.input.answers, selfSubmittedAt: '2026-10-16T01:00:00Z' }
        : command === 'complete_manager' ? { managerAnswers: input.input.answers, managerNote: input.input.managerNote, managerCompletedAt: '2026-10-16T01:00:00Z' }
          : { meeting: input.input, finalisedAt: '2026-10-16T01:00:00Z' }),
    } };
  } });
  try {
    await h.settle();
    if (command === 'submit_self') h.change('self-0', 'Self submitted conflict draft');
    if (command === 'complete_manager') h.change('managerNote', 'PRIVATE-COMPLETE-CONFLICT');
    if (command === 'submit_review') {
      h.change('meeting-date', '2026-10-16'); h.change('meeting-time', '10:00'); h.change('meeting-location', 'Synthetic room');
      h.change('meeting-notes', 'Final meeting conflict draft'); h.change('held', true);
    }
    h.submit(form); await h.settle();
    assert.equal(writes(h).length, 1); assert.ok(h.text.includes('Synthetic conflict.'));
    h.ports.loadPerformanceReviews = async () => ({ ok: true, data: workspace(audience, 'MAM', { reviews: [fresh] }) });
    refresh(h); await h.settle(); assert.equal(writes(h).length, 1);
    h.submit(form); await h.settle();
    assert.equal(writes(h).length, 2); assert.equal(writes(h)[1].args[0].command, command);
    assert.equal(writes(h)[1].args[0].expectedRevision, settings(audience).token);
    assert.deepEqual(writes(h)[1].args[0].input, writes(h)[0].args[0].input);
    assert.ok(h.text.includes(command === 'complete_manager' ? 'Saved.' : 'Submitted.'));
  } finally { h.unmount(); }
});

test('AM-04 manager meeting conflict keeps assessment draft and held confirmation while saving with refreshed revision', async () => {
  let attempt = 0;
  const h = mount(workspace('manager', 'MAM', { reviews: [review('manager', 'MAM', { managerCompletedAt: '2026-10-01T00:00:00Z' })] }), { mutatePerformanceReview: async input => {
    if (++attempt === 1) return failure('conflict');
    return { ok: true, committed: true, operationId: input.operationId, review: { ...updated('manager'), meeting: input.input, managerRevision: 'manager:0:2' } };
  } });
  try {
    await h.settle(); h.change('managerNote', 'PRIVATE-UNSAVED-ASSESSMENT'); h.change('meeting-date', '2026-10-16');
    h.change('meeting-time', '10:00'); h.change('meeting-location', 'Synthetic room'); h.change('meeting-notes', 'Meeting conflict draft'); h.change('held', true);
    h.blur(); await h.settle();
    h.ports.loadPerformanceReviews = async () => ({ ok: true, data: workspace('manager', 'MAM', { reviews: [{ ...updated('manager'), managerCompletedAt: '2026-10-01T00:00:00Z' }] }) });
    refresh(h); await h.settle();
    assert.equal(h.field('managerNote').props.value, 'PRIVATE-UNSAVED-ASSESSMENT');
    assert.equal(h.field('held').props.checked, true);
    h.blur(); await h.settle();
    assert.equal(writes(h)[1].args[0].expectedRevision, 'manager:0:1');
    assert.deepEqual(writes(h)[1].args[0].input, writes(h)[0].args[0].input);
    assert.equal(h.field('managerNote').props.value, 'PRIVATE-UNSAVED-ASSESSMENT');
    assert.equal(h.button('Save and send to HR').props.disabled, true);
  } finally { h.unmount(); }
});
