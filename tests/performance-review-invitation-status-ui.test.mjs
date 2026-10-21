import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './performance-review-harness.mjs';
import { workspace, review, identity, deferred, failure, ids } from './performance-review-fixtures.mjs';

const invited = overrides => review('manager', 'MAM', { managerCompletedAt: '2026-10-21T01:00:00Z', ...overrides });
const hint = 'Reply with Meeting in Outlook';
const save = row => async input => ({ ok: true, committed: true, operationId: input.operationId, review: {
  ...row, managerAnswers: input.input.answers, ratings: input.input.ratings, summary: input.input.summary,
  overallRating: input.input.overallRating, managerNote: input.input.managerNote,
  managerCompletedAt: row.managerCompletedAt ?? '2026-10-21T01:00:00Z',
  [row.audience === 'manager' ? 'managerRevision' : 'readRevision']: input.expectedRevision.replace(/\d+$/, value => String(Number(value) + 1)),
} });

for (const response of [
  { ok: true, reviewId: ids.review, sent: false },
  { ok: true, reviewId: ids.review, sent: 'true' },
  { ok: true, reviewId: ids.other, sent: true },
  failure('unavailable'),
  failure('forbidden'),
]) test(`saved assessment alone cannot confirm invitation delivery: ${JSON.stringify(response)}`, async () => {
  const h = mount(workspace('manager', 'MAM', { reviews: [invited()] }), { loadPerformanceReviewMeetingInvitationStatus: async () => response });
  await h.settle();
  assert.equal(h.invitationStatusCalls.length, 1);
  assert.ok(h.button('Save draft and invite meeting'));
  assert.ok(!h.text.includes(hint));
  assert.ok(!h.all.some(node => node.type === 'button' && node.props.children === 'Save draft'));
  h.unmount();
});

test('invitation confirmation updates only the control and hint while preserving unsaved forms', async () => {
  const row = review('manager');
  let checks = 0;
  const h = mount(workspace('manager', 'MAM', { reviews: [row] }), {
    mutatePerformanceReview: save(row),
    loadPerformanceReviewMeetingInvitationStatus: async reviewId => ({ ok: true, reviewId, sent: ++checks > 1 }),
  });
  await h.settle();
  assert.equal(h.invitationStatusCalls.length, 0);
  h.change('manager-0', 'Initial draft'); h.click('Save draft and invite meeting'); await h.settle();
  assert.equal(h.calls.at(-1).args[0].command, 'complete_manager');
  assert.ok(h.button('Save draft and invite meeting'));
  h.change('managerNote', 'Unsaved latest private note'); h.change('meeting-location', 'Unsaved room');
  h.timers(); await h.settle();
  assert.ok(h.button('Save draft'));
  assert.ok(h.text.includes(hint));
  assert.ok(h.text.includes('ai@mobilityaccess.com.au'));
  assert.equal(h.field('managerNote').props.value, 'Unsaved latest private note');
  assert.equal(h.field('meeting-location').props.value, 'Unsaved room');
  assert.equal(h.calls.filter(call => call.name === 'loadPerformanceReviews').length, 1);
  assert.equal(h.calls.filter(call => call.name === 'mutatePerformanceReview').length, 1);
  const count = h.invitationStatusCalls.length;
  h.timers(); h.focus(); await h.settle();
  assert.equal(h.invitationStatusCalls.length, count);
  h.unmount();
});

test('confirmed button and form submit save draft without inviting again and preserve receipt revisions', async () => {
  const row = invited();
  const h = mount(workspace('manager', 'MAM', { reviews: [row] }), {
    mutatePerformanceReview: save(row),
    loadPerformanceReviewMeetingInvitationStatus: async reviewId => ({ ok: true, reviewId, sent: true }),
  });
  await h.settle();
  h.change('manager-0', 'Changed after invitation'); h.click('Save draft'); await h.settle();
  assert.ok(h.button('Save draft'));
  h.change('managerNote', 'Latest note'); h.submit('Manager assessment'); await h.settle();
  const writes = h.calls.filter(call => call.name === 'mutatePerformanceReview').map(call => call.args[0]);
  assert.deepEqual(writes.map(input => input.command), ['save_manager', 'save_manager']);
  assert.deepEqual(writes.map(input => input.expectedRevision), ['manager:0:0', 'manager:0:1']);
  assert.equal(writes[0].input.answers[0], 'Changed after invitation');
  assert.equal(writes[1].input.managerNote, 'Latest note');
  assert.equal(h.invitationStatusCalls.length, 1);
  h.unmount();
});

test('pending invitation checks continue after the initial burst, coalesce focus and stop on unmount', async () => {
  const h = mount(workspace('manager', 'MAM', { reviews: [invited()] }));
  await h.settle();
  for (let i = 0; i < 9; i++) { h.timers(); await h.settle(); }
  assert.equal(h.invitationStatusCalls.length, 10);
  h.focus(); h.focus(); await h.settle();
  assert.equal(h.invitationStatusCalls.length, 11);
  h.unmount();
  h.timers(); h.focus(); await h.settle();
  assert.equal(h.invitationStatusCalls.length, 11);
});

test('fallback delivery confirmation after the initial burst updates automatically and stops all checks', async () => {
  let checks = 0;
  const h = mount(workspace('manager', 'MAM', { reviews: [invited()] }), {
    loadPerformanceReviewMeetingInvitationStatus: async reviewId => ({ ok: true, reviewId, sent: ++checks === 9 }),
  });
  await h.settle();
  for (let i = 0; i < 7; i++) { h.timers(); await h.settle(); }
  assert.equal(h.invitationStatusCalls.length, 8);
  assert.ok(h.button('Save draft and invite meeting'));
  h.timers(); await h.settle();
  assert.ok(h.button('Save draft')); assert.ok(h.text.includes(hint));
  h.timers(); h.focus(); await h.settle();
  assert.equal(h.invitationStatusCalls.length, 9);
  assert.equal(h.calls.filter(call => call.name === 'loadPerformanceReviews').length, 1);
  h.unmount();
});

test('status errors remain unconfirmed and are rechecked on focus without reloading workspace', async () => {
  const h = mount(workspace('manager', 'MAM', { reviews: [invited()] }), { loadPerformanceReviewMeetingInvitationStatus: async () => { throw Error('Synthetic failure'); } });
  await h.settle();
  assert.ok(h.button('Save draft and invite meeting'));
  assert.ok(!h.text.includes(hint));
  h.ports.loadPerformanceReviewMeetingInvitationStatus = async reviewId => ({ ok: true, reviewId, sent: true });
  h.focus(); await h.settle();
  assert.ok(h.button('Save draft'));
  assert.equal(h.calls.filter(call => call.name === 'loadPerformanceReviews').length, 1);
  h.unmount();
});

test('a late confirmation for another selected employee cannot change the current review', async () => {
  const pending = deferred();
  const secondPerson = { ...identity('MAM', '22000000-0000-4000-8000-000000000003'), name: 'Second Colleague' };
  const second = invited({ id: ids.other, employee: secondPerson, code: 'PR-2026-2' });
  const h = mount(workspace('manager', 'MAM', { reviews: [invited(), second] }), {
    loadPerformanceReviewMeetingInvitationStatus: reviewId => reviewId === ids.review ? pending.promise : Promise.resolve({ ok: true, reviewId, sent: false }),
  });
  await h.settle();
  h.click('Second Colleague — MAM'); await h.settle();
  pending.resolve({ ok: true, reviewId: ids.review, sent: true }); await h.settle();
  assert.ok(h.button('Save draft and invite meeting'));
  assert.ok(!h.text.includes(hint));
  assert.deepEqual(h.invitationStatusCalls.map(call => call.args[0]), [ids.review, ids.other]);
  h.unmount();
});

for (const retirement of ['signout', 'role-change', 'unmount']) test(`late invitation confirmation cannot survive ${retirement}`, async () => {
  const pending = deferred();
  const h = mount(workspace('manager', 'MAM', { reviews: [invited()] }), { loadPerformanceReviewMeetingInvitationStatus: () => pending.promise });
  await h.settle();
  if (retirement === 'signout') h.auth('SIGNED_OUT');
  if (retirement === 'role-change') {
    h.ports.loadPerformanceReviews = async () => ({ ok: true, data: workspace('employee') });
    h.auth('TOKEN_REFRESHED', ids.actor); await h.settle();
  }
  if (retirement === 'unmount') h.unmount();
  pending.resolve({ ok: true, reviewId: ids.review, sent: true }); await h.settle();
  assert.ok(!h.text.includes(hint));
  assert.ok(!h.all.some(node => node.type === 'button' && node.props.children === 'Save draft'));
  h.unmount();
});

for (const audience of ['manager', 'admin', 'system_admin', 'delegate']) test(`confirmed invitation uses current ${audience} scope for status and draft saving`, async () => {
  const row = audience === 'manager' || audience === 'delegate' ? invited() : review('admin', 'MAM', { managerCompletedAt: '2026-10-21T01:00:00Z', capabilities: invited().capabilities });
  const data = workspace(row.audience, 'MAM', { reviews: [row] });
  if (audience === 'system_admin') data.viewerContext.role = 'system_admin';
  const props = audience === 'delegate' ? { previewPersonId: ids.manager } : {};
  const h = mount(data, { mutatePerformanceReview: save(row), loadPerformanceReviewMeetingInvitationStatus: async reviewId => ({ ok: true, reviewId, sent: true }) }, props);
  await h.settle();
  h.click('Save draft'); await h.settle();
  assert.deepEqual(h.invitationStatusCalls[0].args, [ids.review, props.previewPersonId]);
  assert.equal(h.calls.at(-1).args[0].command, 'save_manager');
  assert.equal(h.calls.at(-1).args.length, audience === 'delegate' ? 2 : 1);
  if (audience === 'delegate') assert.equal(h.calls.at(-1).args[1], ids.manager);
  h.unmount();
});

for (const context of ['employee', 'readonly-admin', 'employee-preview', 'wrong-manager']) test(`invitation status and hint are absent for ${context}`, async () => {
  let data = workspace(context === 'readonly-admin' ? 'admin' : context === 'employee' || context === 'employee-preview' ? 'employee' : 'manager');
  if (context === 'wrong-manager') data.reviews = [invited({ manager: { id: ids.other, name: 'Other reviewer' } })];
  const h = mount(data, { loadPerformanceReviewMeetingInvitationStatus: async () => { throw Error('Must not query'); } }, context === 'employee-preview' ? { previewPersonId: ids.person } : {});
  await h.settle();
  assert.equal(h.invitationStatusCalls.length, 0);
  assert.ok(!h.text.includes(hint));
  h.unmount();
});

for (const change of ['actor', 'delegate']) test(`late invitation confirmation cannot cross a changed ${change}`, async () => {
  const pending = deferred();
  const nextManager = '22000000-0000-4000-8000-000000000004';
  const nextActor = '11000000-0000-4000-8000-000000000002';
  const h = mount(workspace('manager', 'MAM', { reviews: [invited()] }), { loadPerformanceReviewMeetingInvitationStatus: () => pending.promise }, change === 'delegate' ? { previewPersonId: ids.manager } : {});
  await h.settle();
  const data = workspace('manager', 'MAM', { reviews: [invited({ manager: { id: nextManager, name: 'New reviewer' } })] });
  data.viewerContext.personId = nextManager;
  if (change === 'actor') data.viewerContext.actorUserId = nextActor;
  h.ports.loadPerformanceReviews = async () => ({ ok: true, data });
  h.ports.loadPerformanceReviewMeetingInvitationStatus = async reviewId => ({ ok: true, reviewId, sent: false });
  if (change === 'actor') h.auth('SIGNED_IN', nextActor);
  else h.setProps({ previewPersonId: nextManager });
  await h.settle();
  pending.resolve({ ok: true, reviewId: ids.review, sent: true }); await h.settle();
  assert.ok(h.button('Save draft and invite meeting'));
  assert.ok(!h.text.includes(hint));
  assert.equal(h.invitationStatusCalls.length, 2);
  assert.deepEqual(h.invitationStatusCalls.at(-1).args, [ids.review, change === 'delegate' ? nextManager : undefined]);
  h.unmount();
});
