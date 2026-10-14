import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import { flush, hooksHarness, loadModule, nodes, text } from './helpers/unified-role-harness.mjs';

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
