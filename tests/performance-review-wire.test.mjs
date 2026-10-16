import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthApiError, AuthSessionMissingError } from '@supabase/supabase-js';
import { loadModule } from './helpers/contact-lifetime-harness.mjs';
import { mount, nodes, text } from './performance-review-harness.mjs';
import { actorId, managerId, review } from './performance-review-backend-fixtures.mjs';
import { productionActionHarness } from './performance-review-production-ui-fixture.mjs';

function composedManager({ meetingEnabled = false } = {}) {
  const { ROLE_CAPABILITY_FIELDS } = loadModule('src/lib/portal-role-capabilities.ts');
  let row = { ...review('manager'), selfStatus: 'manager_review', selfSubmittedAt: '2026-10-15T00:00:00Z', selfAnswers: Array(12).fill('Synthetic self evidence'), selfRevision: 'self:1', managerRevision: 'manager:1:0' };
  row.capabilities.saveManager = true;
  row.capabilities.completeManager = true;
  if (meetingEnabled) {
    row = { ...row, managerAnswers: Array(12).fill('Synthetic manager evidence'), ratings: Array(12).fill('2 Meets expectations'), summary: 'Synthetic summary', overallRating: '2 Meets expectations', managerNote: 'Synthetic private note', managerCompletedAt: '2026-10-15T00:00:00Z' };
    row.capabilities.saveMeeting = true;
  }
  let mutationVersion = 0;
  const rpcCalls = [];
  const data = () => ({ viewerContext: { actorUserId: actorId, personId: managerId, role: 'manager', displayName: 'Synthetic manager' }, reviews: [structuredClone(row)], startablePeople: [] });
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: actorId } }, error: null }) },
    rpc: async (name, args) => {
      rpcCalls.push({ name, args: structuredClone(args) });
      if (name === 'get_portal_role_capabilities') return { data: [{ app_role: 'manager', person_id: managerId, account_status: 'active', ...Object.fromEntries(ROLE_CAPABILITY_FIELDS.map(key => [key, false])) }], error: null, status: 200 };
      if (name === 'performance_review_workspace') return { data: data(), error: null, status: 200 };
      if (name === 'mutate_performance_review') {
        const input = args.p_input;
        mutationVersion++;
        if (args.p_command === 'save_meeting') {
          assert.equal(meetingEnabled, true);
          row = { ...row, meeting: structuredClone(input), managerRevision: 'manager:1:' + mutationVersion };
        } else {
          assert.equal(args.p_command, 'save_manager');
          row = { ...row, managerAnswers: input.answers, ratings: input.ratings, summary: input.summary, overallRating: input.overallRating, managerNote: input.managerNote, managerRevision: 'manager:1:' + mutationVersion };
        }
        return { data: { committed: true, operationId: args.p_operation_id, review: structuredClone(row) }, error: null, status: 200 };
      }
      throw new Error('Unexpected inert RPC boundary');
    },
  };
  const { actions } = productionActionHarness({ client });
  return { data, actions, rpcCalls, client };
}

test('actual manager controls submit canonical rating labels through the actual Server Action', async () => {
  const previous = process.env.MAM_PERFORMANCE_REVIEW_ENABLED;
  process.env.MAM_PERFORMANCE_REVIEW_ENABLED = 'true';
  let ui;
  try {
    const native = composedManager();
    const initial = await native.actions.loadPerformanceReviews();
    assert.equal(initial.ok, true);
    ui = mount(initial.data, native.actions);
    await ui.settle();
    assert.equal(ui.field('rating-0').props.disabled, false);
    for (const name of ['rating-0', 'overallRating']) {
      const option = nodes(ui.field(name)).find(node => node.type === 'option' && text(node) === '2 Meets expectations');
      assert.ok(option, 'The real select exposes the original rating label');
      ui.change(name, option.props.value);
    }
    await ui.click('Save manager draft');
    await ui.settle();
    const writes = native.rpcCalls.filter(call => call.name === 'mutate_performance_review');
    assert.equal(writes.length, 1, 'A permitted real UI save must reach the real Action RPC after closed validation');
    assert.equal(writes[0].args.p_input.ratings[0], '2 Meets expectations');
    assert.equal(writes[0].args.p_input.overallRating, '2 Meets expectations');
    assert.match(ui.text, /Saved\./);
    assert.equal(ui.field('rating-0').props.value, '2 Meets expectations');
  } finally {
    ui?.unmount();
    if (previous === undefined) delete process.env.MAM_PERFORMANCE_REVIEW_ENABLED;
    else process.env.MAM_PERFORMANCE_REVIEW_ENABLED = previous;
  }
});

test('actual meeting controls enforce canonical whole-minute bounds before Action dispatch', async () => {
  const previous = process.env.MAM_PERFORMANCE_REVIEW_ENABLED;
  process.env.MAM_PERFORMANCE_REVIEW_ENABLED = 'true';
  const native = composedManager({ meetingEnabled: true });
  const ui = mount(native.data(), native.actions);
  try {
    await ui.settle();
    assert.equal(ui.field('meeting-duration').props.disabled, false);
    assert.equal(ui.field('meeting-duration').props.min, 5);
    assert.equal(ui.field('meeting-duration').props.max, 480);
    ui.change('meeting-date', '2026-10-16');
    ui.change('meeting-time', '10:00');
    ui.change('meeting-location', 'Synthetic room');
    for (const duration of [4, 481, 5.5]) {
      ui.change('meeting-duration', duration);
      await ui.click('Save meeting');
      await ui.settle();
      assert.equal(ui.calls.filter(call => call.name === 'mutatePerformanceReview').length, 0);
    }
    for (const duration of [5, 480]) {
      ui.change('meeting-duration', duration);
      await ui.click('Save meeting');
      await ui.settle();
      assert.equal(native.rpcCalls.filter(call => call.name === 'mutate_performance_review').at(-1).args.p_input.duration, duration);
      assert.match(ui.text, /Saved\./);
    }
    assert.equal(native.rpcCalls.filter(call => call.name === 'mutate_performance_review').length, 2);
  } finally {
    ui.unmount();
    if (previous === undefined) delete process.env.MAM_PERFORMANCE_REVIEW_ENABLED;
    else process.env.MAM_PERFORMANCE_REVIEW_ENABLED = previous;
  }
});

test('a definitive native Auth loss clears the mounted private workspace through the actual Action', async () => {
  const previous = process.env.MAM_PERFORMANCE_REVIEW_ENABLED;
  process.env.MAM_PERFORMANCE_REVIEW_ENABLED = 'true';
  let ui;
  try {
    const native = composedManager();
    ui = mount(native.data(), native.actions);
    await ui.settle();
    assert.ok(ui.all.some(node => node.type === 'textarea' && node.props.name === 'managerNote'));
    native.client.auth.getUser = async () => ({ data: { user: null }, error: new AuthSessionMissingError() });
    const response = await native.actions.loadPerformanceReviews();
    assert.equal(response.code, 'unauthenticated');
    await ui.click('Reload');
    await ui.settle();
    assert.ok(!ui.all.some(node => node.type === 'textarea' && node.props.name === 'managerNote'));
    assert.ok(!ui.all.some(node => node.type === 'button' && text(node) === 'Download Word'));
    assert.equal(native.rpcCalls.filter(call => call.name === 'mutate_performance_review').length, 0);
  } finally {
    ui?.unmount();
    if (previous === undefined) delete process.env.MAM_PERFORMANCE_REVIEW_ENABLED;
    else process.env.MAM_PERFORMANCE_REVIEW_ENABLED = previous;
  }
});

test('canonical role denial clears private state while a transient role failure preserves it', async () => {
  const previous = process.env.MAM_PERFORMANCE_REVIEW_ENABLED;
  process.env.MAM_PERFORMANCE_REVIEW_ENABLED = 'true';
  try {
    for (const [status, expected, retainsPrivate] of [[503, 'unavailable', true], [403, 'forbidden', false]]) {
      const native = composedManager();
      const ui = mount(native.data(), native.actions);
      try {
        await ui.settle();
        const originalRpc = native.client.rpc;
        native.client.rpc = async (name, args) => name === 'get_portal_role_capabilities'
          ? { data: null, error: { code: '42501', message: 'SYNTHETIC PRIVATE PROVIDER DETAIL' }, status }
          : originalRpc(name, args);
        const result = await native.actions.loadPerformanceReviews();
        assert.equal(result.code, expected);
        assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC PRIVATE/);
        await ui.click('Reload');
        await ui.settle();
        assert.equal(ui.all.some(node => node.type === 'textarea' && node.props.name === 'managerNote'), retainsPrivate);
        assert.equal(native.rpcCalls.filter(call => call.name === 'mutate_performance_review').length, 0);
      } finally { ui.unmount(); }
    }
  } finally {
    if (previous === undefined) delete process.env.MAM_PERFORMANCE_REVIEW_ENABLED;
    else process.env.MAM_PERFORMANCE_REVIEW_ENABLED = previous;
  }
});

test('canonical RPC JWT rejection retires private data even when the preceding Auth check succeeded', async () => {
  const previous = process.env.MAM_PERFORMANCE_REVIEW_ENABLED;
  process.env.MAM_PERFORMANCE_REVIEW_ENABLED = 'true';
  try {
    for (const [status, expected, retainsPrivate] of [[503, 'unavailable', true], [401, 'unauthenticated', false]]) {
      const native = composedManager();
      const ui = mount(native.data(), native.actions);
      try {
        await ui.settle();
        const originalRpc = native.client.rpc;
        native.client.rpc = async (name, args) => name === 'get_portal_role_capabilities'
          ? { data: null, error: { code: 'PGRST301', message: 'SYNTHETIC JWT FAILURE' }, status }
          : originalRpc(name, args);
        assert.equal((await native.actions.loadPerformanceReviews()).code, expected);
        await ui.click('Reload');
        await ui.settle();
        assert.equal(ui.all.some(node => node.type === 'textarea' && node.props.name === 'managerNote'), retainsPrivate);
        assert.equal(native.rpcCalls.filter(call => call.name === 'mutate_performance_review').length, 0);
      } finally { ui.unmount(); }
    }
  } finally {
    if (previous === undefined) delete process.env.MAM_PERFORMANCE_REVIEW_ENABLED;
    else process.env.MAM_PERFORMANCE_REVIEW_ENABLED = previous;
  }
});

test('native Auth HTTP denials retire private state but outages and rate limits do not', async () => {
  const previous = process.env.MAM_PERFORMANCE_REVIEW_ENABLED;
  process.env.MAM_PERFORMANCE_REVIEW_ENABLED = 'true';
  try {
    for (const [status, expected, retainsPrivate] of [[503, 'unavailable', true], [429, 'unavailable', true], [401, 'unauthenticated', false], [403, 'unauthenticated', false]]) {
      const native = composedManager();
      const ui = mount(native.data(), native.actions);
      try {
        await ui.settle();
        native.client.auth.getUser = async () => ({ data: { user: null }, error: new AuthApiError('SYNTHETIC AUTH DETAILS', status, 'bad_jwt') });
        const result = await native.actions.loadPerformanceReviews();
        assert.equal(result.code, expected);
        assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC AUTH/);
        await ui.click('Reload');
        await ui.settle();
        assert.equal(ui.all.some(node => node.type === 'textarea' && node.props.name === 'managerNote'), retainsPrivate);
      } finally { ui.unmount(); }
    }
  } finally {
    if (previous === undefined) delete process.env.MAM_PERFORMANCE_REVIEW_ENABLED;
    else process.env.MAM_PERFORMANCE_REVIEW_ENABLED = previous;
  }
});
