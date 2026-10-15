import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import { deferred, flush, hooksHarness, loadModule, nodes, text } from './helpers/unified-role-harness.mjs';

function tasksUI(initialProps = {}, response = { data: [], error: null }) {
  const hooks = hooksHarness(React), timers = new Map(), calls = [];
  let props = initialProps, timerId = 0;
  globalThis.window = { setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); } };
  const emptyTasks = { tasks: [], loading: false, error: '', notice: '', pendingId: '', load: async () => {}, complete: async () => {} };
  const { CheckInTasks } = loadModule('src/components/check-in-tasks.tsx', {
    react: hooks.react,
    '@/components/subscription-review-tasks': { useSubscriptionReviewTasks: () => emptyTasks },
    '@/components/subscription-password-tasks': { useSubscriptionPasswordTasks: () => emptyTasks },
    '@/components/ui/use-media-query': { useMediaQuery: () => false },
    '@/components/ui/use-dialog-focus': { useDialogFocus() {} },
    '@/lib/supabase/client': { createClient: () => ({ rpc: async (name, args) => { calls.push({ name, args }); return response; } }) },
  });
  const render = () => { hooks.begin(); const tree = CheckInTasks(props); hooks.effects(); return tree; };
  return {
    calls, render, setProps(next) { props = next; },
    async settle() {
      for (let i = 0; i < 3; i++) {
        render();
        for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
        await flush();
      }
      return render();
    },
  };
}

const options = tree => nodes(tree).filter(node => node.type === 'option').map(node => node.props.value);

test('reviewer task reads require an explicit permission opt-in', async () => {
  const ui = tasksUI();
  const tree = await ui.settle();
  assert.deepEqual(ui.calls, []);
  assert.ok(!options(tree).includes('check_in'));
});

test('Tasks hides the check-in type and performs no check-in read without review permission', async () => {
  const ui = tasksUI({ showCheckInTasks: false });
  const tree = await ui.settle();
  assert.deepEqual(ui.calls, []);
  assert.ok(!options(tree).includes('check_in'));
  assert.ok(options(tree).includes('subscription_review'));
  assert.ok(options(tree).includes('work_schedule'));
  assert.doesNotMatch(text(tree), /permission to view check-in/);
});

test('Tasks hides subscription task types when their channel is disabled', async () => {
  const tree = await tasksUI({ showSubscriptionReviewTasks: false }).settle();
  assert.ok(!options(tree).includes('subscription_review'));
  assert.ok(!options(tree).includes('subscription_password'));
  assert.ok(options(tree).includes('work_schedule'));
});

test('revoking the check-in channel immediately removes cached rows and its selected filter', async () => {
  const ui = tasksUI({ showCheckInTasks: true }, { data: [{
    person_id: '11000000-0000-4000-8000-000000000005', full_name: 'Synthetic check-in employee', company_key: 'mam',
    reminders: [{ id: '66000000-0000-4000-8000-000000000001', milestone: '1_month', sequence: 'initial', dueDate: '2000-01-01', status: 'delivered' }],
  }], error: null });
  let tree = await ui.settle();
  assert.match(text(tree), /Synthetic check-in employee/);
  nodes(tree).find(node => node.type === 'select' && nodes(node).some(option => option.props?.value === 'check_in'))
    .props.onChange({ target: { value: 'check_in' } });
  ui.setProps({ showCheckInTasks: false });
  tree = ui.render();
  assert.doesNotMatch(text(tree), /Synthetic check-in employee/);
  const type = nodes(tree).find(node => node.type === 'select' && nodes(node).some(option => option.props?.value === 'work_schedule'));
  assert.equal(type.props.value, 'all');
  await ui.settle();
  assert.equal(ui.calls.length, 1);
});

for (const code of ['42501', 'XX000']) test(`authorized check-in loads retain genuine ${code} failures`, async () => {
  const ui = tasksUI({ showCheckInTasks: true }, { data: null, error: { code, message: 'synthetic private provider detail' } });
  const tree = await ui.settle();
  assert.equal(ui.calls.length, 1);
  assert.match(text(tree), code === '42501' ? /permission to view check-in tasks/ : /could not be loaded/);
  assert.doesNotMatch(text(tree), /synthetic private provider detail/);
});

const scheduleItem = (id, submittedAt) => ({
  id, status: 'submitted', submittedAt, requestReason: 'Synthetic reason', submittedByName: 'Synthetic submitter',
  originalWorkingWeekdays: null, originalWorkingDayTimes: [], requestedWorkingWeekdays: [1, 2, 3, 4, 5], requestedWorkingDayTimes: [],
});
const schedule = {
  activePersonId: 'sched-active', activePersonName: 'Synthetic schedule employee', reviews: [],
  history: [scheduleItem('sched-1', '2000-01-01')],
};
const manySchedule = {
  activePersonId: 'sched-active', activePersonName: 'Synthetic schedule employee', reviews: [],
  history: Array.from({ length: 9 }, (_, index) => scheduleItem(`sched-${index}`, `2000-01-${String(index + 1).padStart(2, '0')}`)),
};
const reviewRow = { subscription_id: '33000000-0000-4000-8000-000000000010', service_name: 'Synthetic private subscription', next_review_on: '2000-01-01', subscription_status: 'active', version: 1 };
const channelRpc = { check_in: 'list_my_employee_check_in_tasks', subscription_review: 'list_my_subscription_review_tasks', subscription_password: 'list_my_subscription_password_tasks' };

function realChannelUI(initialProps = {}, outcomes = {}) {
  const hooks = hooksHarness(React), timers = new Map(), calls = [];
  let props = { workScheduleWorkspace: schedule, ...initialProps }, counter = 0, reviewHook;
  let reviewAction = async () => ({ ok: true, task: null });
  globalThis.window = { setTimeout(fn) { const id = ++counter; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); } };
  const overrides = {
    react: hooks.react,
    '@/components/ui/use-media-query': { useMediaQuery: () => false },
    '@/components/ui/use-dialog-focus': { useDialogFocus() {} },
    '@/components/task-notes-editor': { TaskNotesEditor: 'TaskNotesEditor' },
    '@/components/ui/motion-loader': { MotionLoader: 'MotionLoader' },
    '@/lib/supabase/client': {
      createClient: () => ({
        rpc: async (name, args) => {
          calls.push({ name, args });
          const channel = Object.entries(channelRpc).find(([, rpcName]) => rpcName === name)?.[0];
          const outcome = channel ? outcomes[channel] : undefined;
          return outcome ? await outcome(name, args) : { data: [], error: null };
        },
      }),
    },
    '@/app/check-in-tasks/actions': { completeMyEmployeeCheckInTask: async () => {} },
    '@/app/subscriptions/review-task-actions': { completeMySubscriptionReviewTask: async (...callArgs) => reviewAction(...callArgs) },
    '@/app/subscriptions/password-task-actions': { completeMySubscriptionPasswordTask: async () => ({ ok: true }) },
  };
  const review = loadModule('src/components/subscription-review-tasks.tsx', overrides);
  overrides['@/components/subscription-review-tasks'] = { useSubscriptionReviewTasks: (opts) => (reviewHook = review.useSubscriptionReviewTasks(opts)) };
  const password = loadModule('src/components/subscription-password-tasks.tsx', overrides);
  overrides['@/components/subscription-password-tasks'] = { useSubscriptionPasswordTasks: (opts) => password.useSubscriptionPasswordTasks(opts) };
  const { CheckInTasks } = loadModule('src/components/check-in-tasks.tsx', overrides);
  const render = () => { hooks.begin(); const tree = CheckInTasks(props); hooks.effects(); return tree; };
  return {
    calls, render,
    setProps(next) { props = { ...props, ...next }; },
    setReviewAction(fn) { reviewAction = fn; },
    completeReview() { reviewHook.complete(reviewHook.tasks[0]); },
    async settle() {
      for (let i = 0; i < 4; i++) {
        render();
        for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
        await flush();
      }
      return render();
    },
  };
}

for (const channel of Object.keys(channelRpc)) {
  const enableProps = channel === 'check_in'
    ? { showCheckInTasks: true, showSubscriptionReviewTasks: false }
    : { showCheckInTasks: false, showSubscriptionReviewTasks: true };
  const disableProps = { showCheckInTasks: false, showSubscriptionReviewTasks: false };

  test(`disabling ${channel} clears its cached permission error on the first render, before the clearing timer runs`, async () => {
    const ui = realChannelUI(enableProps, { [channel]: async () => ({ data: null, error: { code: '42501', message: 'synthetic private detail' } }) });
    const enabledTree = await ui.settle();
    assert.equal(nodes(enabledTree).filter((node) => node.props?.role === 'alert').length, 1);
    ui.setProps(disableProps);
    const tree = ui.render();
    assert.equal(nodes(tree).filter((node) => node.props?.role === 'alert').length, 0, `${channel} still shows its cached error after being disabled`);
    assert.match(text(tree), /Synthetic schedule employee/);
  });

  test(`disabling ${channel} clears its cached loading and the Refresh control-disable state on the first render, before the clearing timer runs`, async () => {
    const held = deferred();
    const ui = realChannelUI(enableProps, { [channel]: () => held.promise });
    await ui.settle();
    ui.setProps(disableProps);
    const tree = ui.render();
    assert.equal(nodes(tree).some((node) => node.type === 'MotionLoader'), false, `${channel} still shows its cached loading spinner after being disabled`);
    const refresh = nodes(tree).find((node) => node.props?.['aria-label'] === 'Refresh tasks');
    assert.equal(refresh.props.disabled, false, `${channel} still disables Refresh after being disabled`);
    assert.match(text(tree), /Synthetic schedule employee/);
  });
}

test('a disabled channel\'s stale loading does not block pagination for an independently permitted schedule', async () => {
  const held = deferred();
  const ui = realChannelUI({ showCheckInTasks: true, showSubscriptionReviewTasks: false, workScheduleWorkspace: manySchedule }, { check_in: () => held.promise });
  let tree = await ui.settle();
  const next = nodes(tree).find((node) => node.props?.['aria-label'] === 'Next page');
  next.props.onClick();
  tree = ui.render();
  ui.setProps({ showCheckInTasks: false });
  tree = ui.render();
  const previous = nodes(tree).find((node) => node.props?.['aria-label'] === 'Previous page');
  assert.equal(previous.props.disabled, false, 'disabled check_in still disables pagination for the independent schedule list');
});

test('a disabled channel with no tasks reaches the empty state immediately instead of a stale loading spinner', async () => {
  const held = deferred();
  const ui = realChannelUI({ showCheckInTasks: true, showSubscriptionReviewTasks: false, workScheduleWorkspace: { activePersonId: null, activePersonName: null, reviews: [], history: [] } }, { check_in: () => held.promise });
  await ui.settle();
  ui.setProps({ showCheckInTasks: false });
  const tree = ui.render();
  assert.match(text(tree), /No tasks need your action/);
});

test('disabling the subscription review channel clears a cached completion notice that still names the private service', async () => {
  const ui = realChannelUI({ showCheckInTasks: false, showSubscriptionReviewTasks: true }, { subscription_review: async () => ({ data: [reviewRow], error: null }) });
  await ui.settle();
  ui.completeReview();
  await flush();
  assert.match(text(ui.render()), /Synthetic private subscription.s review is complete/);
  ui.setProps({ showSubscriptionReviewTasks: false });
  const tree = ui.render();
  assert.doesNotMatch(text(tree), /Synthetic private subscription/, 'disabled subscription review still exposes its cached completion notice');
});

test('a subscription review channel\'s stale pending state does not block Refresh once that channel is disabled', async () => {
  const held = deferred();
  const ui = realChannelUI({ showCheckInTasks: false, showSubscriptionReviewTasks: true }, { subscription_review: async () => ({ data: [reviewRow], error: null }) });
  await ui.settle();
  ui.setReviewAction(() => held.promise);
  ui.completeReview();
  await flush();
  ui.setProps({ showSubscriptionReviewTasks: false });
  const tree = ui.render();
  const refresh = nodes(tree).find((node) => node.props?.['aria-label'] === 'Refresh tasks');
  assert.equal(refresh.props.disabled, false, 'a disabled channel\'s stale pending write still blocks Refresh');
});

test('an enabled subscription review channel\'s genuine pending write still blocks Refresh', async () => {
  const held = deferred();
  const ui = realChannelUI({ showCheckInTasks: false, showSubscriptionReviewTasks: true }, { subscription_review: async () => ({ data: [reviewRow], error: null }) });
  await ui.settle();
  ui.setReviewAction(() => held.promise);
  ui.completeReview();
  await flush();
  const tree = ui.render();
  const refresh = nodes(tree).find((node) => node.props?.['aria-label'] === 'Refresh tasks');
  assert.equal(refresh.props.disabled, true, 'an in-flight enabled-channel write should still disable Refresh');
});

test('an independent schedule completion callback retains its notice when the check-in channel is disabled', async () => {
  const onScheduleReview = async () => ({ ok: true });
  const reviewableSchedule = {
    activePersonId: 'sched-active', activePersonName: 'Synthetic schedule employee',
    reviews: [{ ...scheduleItem('sched-review-1', '2000-01-01'), personId: 'sched-active', employeeName: 'Synthetic schedule employee' }],
    history: [],
  };
  const ui = realChannelUI({ showCheckInTasks: false, showSubscriptionReviewTasks: false, onScheduleReview, workScheduleWorkspace: reviewableSchedule });
  let tree = await ui.settle();
  const row = nodes(tree).find((node) => node.type === 'button' && typeof node.props?.['aria-label'] === 'string' && node.props['aria-label'].startsWith('Open '));
  row.props.onClick();
  tree = ui.render();
  const decision = nodes(tree).find((node) => typeof node.props?.onSaved === 'function' && node.props.onReview === onScheduleReview);
  assert.ok(decision, 'the actual parent must expose the schedule decision callback');
  decision.props.onSaved('Schedule request approved.');
  tree = ui.render();
  assert.match(text(tree), /Schedule request approved/);
});

for (const channel of ['check_in', 'subscription_review']) test(`retired ${channel} notes cannot keep the independent schedule workspace busy`, async () => {
  const name = channel === 'check_in' ? 'Synthetic private check-in employee' : reviewRow.service_name;
  const result = channel === 'check_in' ? { data: [{
    person_id: '11000000-0000-4000-8000-000000000005', full_name: name, company_key: 'mam',
    reminders: [{ id: '66000000-0000-4000-8000-000000000001', milestone: '1_month', sequence: 'initial', dueDate: '2000-01-01', status: 'delivered' }],
  }], error: null } : { data: [reviewRow], error: null };
  const ui = realChannelUI({ showCheckInTasks: channel === 'check_in', showSubscriptionReviewTasks: channel === 'subscription_review' }, { [channel]: async () => result });
  let tree = await ui.settle();
  const row = nodes(tree).find((node) => node.type === 'button' && node.props?.['aria-label']?.startsWith(`Open ${name}'s `));
  assert.ok(row);
  row.props.onClick();
  tree = ui.render();
  const notes = nodes(tree).find((node) => node.type === 'TaskNotesEditor' && node.props.target.kind === channel);
  assert.ok(notes);
  notes.props.onBusyChange(true);
  tree = ui.render();
  assert.equal(nodes(tree).find((node) => node.props?.['aria-label'] === 'Refresh tasks').props.disabled, true);
  const priorReads = ui.calls.length;
  ui.setProps({ showCheckInTasks: false, showSubscriptionReviewTasks: false });
  tree = ui.render();
  assert.equal(nodes(tree).some((node) => node.type === 'TaskNotesEditor'), false);
  assert.equal(nodes(tree).find((node) => node.props?.['aria-label'] === 'Refresh tasks').props.disabled, false, 'retired private notes must not own the current busy state');
  const allowedRow = nodes(tree).find((node) => node.type === 'button' && node.props?.['aria-label']?.startsWith("Open Synthetic schedule employee's "));
  assert.ok(allowedRow);
  assert.equal(allowedRow.props.disabled, false);
  assert.equal(ui.calls.length, priorReads);
});

test('the currently selected schedule retains its own notes busy state', async () => {
  const ui = realChannelUI({ showCheckInTasks: false, showSubscriptionReviewTasks: false });
  let tree = await ui.settle();
  const row = nodes(tree).find((node) => node.type === 'button' && node.props?.['aria-label']?.startsWith("Open Synthetic schedule employee's "));
  assert.ok(row);
  row.props.onClick();
  tree = ui.render();
  const notes = nodes(tree).find((node) => node.type === 'TaskNotesEditor' && node.props.target.kind === 'work_schedule');
  assert.ok(notes);
  notes.props.onBusyChange(true);
  ui.setProps({ showCheckInTasks: false, showSubscriptionReviewTasks: false });
  tree = ui.render();
  assert.equal(nodes(tree).find((node) => node.props?.['aria-label'] === 'Refresh tasks').props.disabled, true);
  assert.ok(nodes(tree).some((node) => node.type === 'TaskNotesEditor' && node.props.target.kind === 'work_schedule'));
});
