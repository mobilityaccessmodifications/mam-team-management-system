import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilities, loadModule } from './helpers/unified-role-harness.mjs';
import { shell, nodes, deferred, personId as previewId } from './uat-performance-shell-fixture.mjs';

const actorId = '91000000-0000-4000-8000-000000000001';
const personId = '92000000-0000-4000-8000-000000000001';

async function home({ flag, actor = capabilities('employee', personId), user = { id: actorId }, roleOk = true, params = { view: 'people', tab: 'performance' } } = {}) {
  const previous = process.env.MAM_PERFORMANCE_REVIEW_ENABLED;
  if (flag === undefined) delete process.env.MAM_PERFORMANCE_REVIEW_ENABLED;
  else process.env.MAM_PERFORMANCE_REVIEW_ENABLED = flag;
  const calls = [];
  const { default: Home } = loadModule('src/app/page.tsx', {
    '@/components/leave-demo': { LeaveDemo: 'LeaveDemo' },
    '@/components/role-permission-recovery': { RolePermissionRecovery: 'RolePermissionRecovery' },
    '@/app/roles/actions': { getPortalRoleCapabilities: async () => { calls.push('canonical'); return roleOk ? { ok: true, capabilities: actor } : { ok: false }; } },
    '@/lib/check-in-register': { getCheckInResourceLinks: () => ({}) },
    '@/lib/supabase/config': { isSupabaseConfigured: () => true },
    '@/lib/supabase/server': { createClient: async () => ({
      auth: { getUser: async () => ({ data: { user }, error: null }) },
      rpc: async (name) => { calls.push(name); assert.equal(name, 'can_view_subscription_review_calendar'); return { data: false, error: null }; },
    }) },
    'next/navigation': { redirect: (path) => { throw new Error('redirect:' + path); } },
  });
  try { return { tree: await Home({ searchParams: Promise.resolve(params) }), calls }; }
  finally {
    if (previous === undefined) delete process.env.MAM_PERFORMANCE_REVIEW_ENABLED;
    else process.env.MAM_PERFORMANCE_REVIEW_ENABLED = previous;
  }
}

test('SSR accepts the performance section and passes only a server-derived enabled Boolean with the actual Auth actor', async () => {
  const { tree, calls } = await home({ flag: 'true' });
  assert.equal(tree.props.initialNavigation.peopleSection, 'performance');
  assert.equal(tree.props.performanceReviewEnabled, true);
  assert.equal(tree.props.authActorId, actorId);
  assert.notEqual(tree.props.authActorId, tree.props.currentPersonId);
  assert.deepEqual(calls, ['canonical', 'can_view_subscription_review_calendar']);
});

test('an actual Employee can open native Performance reviews without HR directory or organisation rights', async () => {
  const ui = shell();
  try {
    const tree = await ui.settle();
    const tabs = ui.tabs();
    assert.ok(tabs?.options.some(option => option.value === 'performance' && option.label === 'Performance reviews'));
    assert.equal(nodes(tree).filter(node => node.type === 'performance-spy').length, 1);
    assert.equal(ui.mounts.length, 1);
    assert.equal(ui.people().showOrganisation, false);
    assert.equal(ui.people().renderEmployeeDirectory.type, 'employee-team-directory');
    assert.equal(ui.people().renderAccounts, undefined);
    assert.equal(ui.people().renderCheckInRegister, undefined);
    assert.ok(ui.dynamicLoads.some(row => row.path === '@/components/performance-review-workspace' && row.loading === 'function'));
  } finally { ui.cleanup(); }
});

test('the native review workspace stays lazy until its tab is opened and unmounts outside People', async () => {
  const ui = shell({ initialTab: 'tasks' });
  try {
    await ui.settle();
    assert.equal(ui.mounts.length, 0);
    ui.selectTab('performance');
    assert.equal(ui.mounts.length, 1);
    ui.navigate('home');
    assert.equal(ui.unmounts.length, 1);
    assert.equal(nodes(ui.render()).filter(node => node.type === 'performance-spy').length, 0);
    ui.navigate('people');
    assert.equal(ui.mounts.length, 2);
  } finally { ui.cleanup(); }
});

test('Change profile mounts target-bound read-only reviews even for the actors own linked person', async () => {
  const ui = shell({ role: 'system_admin', actor: capabilities('system_admin', personId) });
  try {
    await ui.settle();
    assert.equal(ui.mounts.length, 1);
    ui.preview(previewId);
    await ui.settle();
    ui.navigate('people');
    await ui.settle();
    assert.equal(ui.people().isAccessPreview, true);
    assert.equal(ui.people().activeProfile.accessRole, 'admin');
    assert.ok(ui.tabs().options.some(option => option.value === 'performance'));
    assert.equal(ui.people().renderPerformanceReviews.props.previewPersonId, previewId);
    ui.selectTab('performance');
    assert.equal(nodes(ui.render()).filter(node => node.type === 'performance-spy').length, 1);
    assert.equal(ui.mounts.length, 2);
    assert.equal(ui.unmounts.length, 1);
    assert.ok(ui.people().renderAccounts);
    assert.ok(ui.people().renderAssetRegister);
    assert.equal(ui.people().renderAnalyticsApiManagement, undefined);
  } finally { ui.cleanup(); }
});

test('clicking real Sign out unmounts reviews immediately while both sign-out promises are still pending', async () => {
  const pending = deferred();
  const ui = shell({ signOutPending: pending });
  try {
    const tree = await ui.settle();
    assert.equal(ui.mounts.length, 1);
    nodes(tree).find(node => node.type === 'button' && node.props['aria-label'] === 'Sign out').props.onClick();
    const signingOut = ui.render();
    assert.equal(ui.unmounts.length, 1);
    assert.equal(nodes(signingOut).filter(node => node.type === 'performance-spy').length, 0);
    assert.ok(!ui.tabs().options.some(option => option.value === 'performance'));
    assert.equal(nodes(signingOut).find(node => node.props['aria-label'] === 'Signing out').props.disabled, true);
    assert.deepEqual(ui.calls.filter(([name]) => /signout/.test(name)), [['server-signout'], ['browser-signout']]);
    pending.resolve({ error: null });
    await ui.settle();
    assert.equal(ui.mounts.length, 1);
  } finally { pending.resolve({ error: null }); ui.cleanup(); }
});

test('native Auth sign-out retires the review lifetime without waiting for navigation', async () => {
  const ui = shell();
  try {
    await ui.settle();
    assert.equal(ui.mounts.length, 1);
    ui.auth('SIGNED_OUT', null);
    assert.equal(ui.unmounts.length, 1);
    assert.ok(!ui.tabs().options.some(option => option.value === 'performance'));
    ui.auth('SIGNED_IN', actorId);
    assert.equal(ui.mounts.length, 1, 'a retired Auth lifetime needs a fresh server-authenticated shell');
  } finally { ui.cleanup(); }
});

test('actual scope keys retire across Change profile A to B to A and return to the same Auth actor', async () => {
  const ui = shell({ role: 'system_admin' });
  try {
    await ui.settle();
    const originalKey = ui.people().renderPerformanceReviews.key;
    assert.ok(originalKey.includes(actorId));
    let expectedMounts = 1;
    const keys = new Set([originalKey]);
    for (const id of [personId, '92000000-0000-4000-8000-000000000002', personId]) {
      ui.preview(id);
      await ui.settle();
      ui.navigate('people');
      await ui.settle();
      assert.ok(ui.tabs().options.some(option => option.value === 'performance'));
      assert.equal(ui.people().renderPerformanceReviews.props.previewPersonId, id);
      const key = ui.people().renderPerformanceReviews.key;
      assert.ok(key.includes(actorId) && key.includes(id));
      assert.ok(!keys.has(key)); keys.add(key);
      ui.selectTab('performance');
      assert.equal(ui.mounts.length, ++expectedMounts);
    }
    ui.preview('');
    await ui.settle();
    ui.navigate('people');
    await ui.settle();
    assert.notEqual(ui.people().renderPerformanceReviews.key, originalKey);
    assert.ok(ui.people().renderPerformanceReviews.key.includes(actorId));
    ui.selectTab('performance');
    assert.equal(ui.people().renderPerformanceReviews.props.previewPersonId, undefined);
    assert.equal(ui.mounts.length, ++expectedMounts);
  } finally { ui.cleanup(); }
});

for (const flag of [undefined, 'false', 'TRUE', '1', ' true ', '']) test(`SSR feature flag ${JSON.stringify(flag)} stays off without new RPCs`, async () => {
  const { tree, calls } = await home({ flag });
  assert.equal(tree.props.performanceReviewEnabled, false);
  assert.deepEqual(calls, ['canonical', 'can_view_subscription_review_calendar']);
});

test('disabled reviews expose neither a tab nor a mounted panel and do not add Auth or Action calls', async () => {
  const ui = shell({ enabled: false });
  try {
    const tree = await ui.settle();
    assert.ok(!ui.tabs().options.some(option => option.value === 'performance'));
    assert.equal(nodes(tree).filter(node => node.type === 'performance-spy').length, 0);
    assert.equal(ui.mounts.length, 0);
    ui.auth('SIGNED_OUT', null);
    assert.equal(ui.people().renderPerformanceReviews, undefined);
    assert.ok(!ui.calls.some(([name]) => name.startsWith('auth-') || name === 'capabilities'));
  } finally { ui.cleanup(); }
});

for (const role of ['account', 'manager', 'admin', 'system_admin']) test(`actual ${role} reaches reviews without changing any other People module permission`, async () => {
  const snapshot = people => ({
    role: people.activeProfile.accessRole, organisation: people.showOrganisation,
    directory: people.renderEmployeeDirectory?.type, accounts: Boolean(people.renderAccounts),
    assets: Boolean(people.renderAssetRegister), checkins: Boolean(people.renderCheckInRegister),
    subscriptions: people.renderSubscriptionRegister?.type, analytics: Boolean(people.renderAnalyticsApiManagement),
  });
  const off = shell({ role, enabled: false });
  let expected;
  try { await off.settle(); expected = snapshot(off.people()); } finally { off.cleanup(); }
  const ui = shell({ role });
  try {
    await ui.settle();
    assert.deepEqual(snapshot(ui.people()), expected);
    assert.ok(ui.tabs().options.some(option => option.value === 'performance'));
    assert.equal(ui.mounts.length, 1);
    if (role === 'account') {
      assert.equal(ui.people().showOrganisation, false);
      assert.equal(ui.people().renderAccounts, undefined);
      assert.equal(ui.people().renderCheckInRegister, undefined);
    }
  } finally { ui.cleanup(); }
});

test('role acquisition loading and definitive failure unmount reviews rather than falling back to Employee', async () => {
  const pending = deferred();
  const ui = shell({ role: 'admin', roleResult: () => pending.promise });
  try {
    await ui.settle();
    assert.equal(ui.mounts.length, 1);
    const invalidate = ui.people().renderEmployeeDirectory.props.onRecordsChanged;
    const invalidating = invalidate();
    ui.render();
    assert.equal(ui.people(), undefined);
    assert.equal(ui.unmounts.length, 1);
    await invalidating;
    pending.resolve({ ok: false, error: 'Role permissions could not be loaded.' });
    await ui.settle();
    assert.equal(ui.people(), undefined);
    assert.equal(ui.mounts.length, 1);
  } finally { pending.resolve({ ok: false }); ui.cleanup(); }
});

test('native Auth actor A to B to A cannot revive the old capability scope', async () => {
  const ui = shell();
  try {
    await ui.settle();
    ui.auth('TOKEN_REFRESHED', actorId);
    assert.equal(ui.unmounts.length, 0);
    ui.auth('SIGNED_IN', personId);
    assert.equal(ui.unmounts.length, 1);
    ui.auth('SIGNED_IN', actorId);
    assert.equal(ui.mounts.length, 1);
    assert.ok(!ui.tabs().options.some(option => option.value === 'performance'));
  } finally { ui.cleanup(); }
});

test('missing canonical role or actual Auth identity cannot mount reviews', async () => {
  for (const options of [{ actor: null }, { authId: null }, { actor: { ...capabilities('employee', personId), account_status: 'disabled' } }]) {
    const ui = shell({ ...options, currentPersonId: personId });
    try {
      await ui.settle();
      assert.equal(ui.mounts.length, 0);
      assert.ok(!ui.tabs()?.options.some(option => option.value === 'performance'));
    } finally { ui.cleanup(); }
  }
});

test('SSR authentication and canonical role failure never return the shell', async () => {
  const failed = await home({ flag: 'true', roleOk: false });
  assert.equal(failed.tree.type, 'RolePermissionRecovery');
  assert.deepEqual(failed.calls, ['canonical']);
  await assert.rejects(home({ flag: 'true', user: null }), /redirect:\/login/);
});

test('legacy SSR People sections and first-value query semantics remain unchanged', async () => {
  for (const tab of ['assets', 'accounts', 'subscriptions', 'tasks']) {
    const { tree } = await home({ flag: 'true', params: { view: 'people', tab } });
    assert.equal(tree.props.initialNavigation.peopleSection, tab);
  }
  const array = await home({ flag: 'true', params: { view: ['about', 'leave'], tab: ['performance', 'assets'] } });
  assert.equal(array.tree.props.initialNavigation.view, 'people');
  assert.equal(array.tree.props.initialNavigation.peopleSection, 'performance');
  const unknown = await home({ flag: 'true', params: { view: 'people', tab: 'reviews' } });
  assert.equal(unknown.tree.props.initialNavigation.peopleSection, undefined);
});

test('all pre-existing People tabs keep their order and real tab events still select the original panels', async () => {
  const ui = shell({ role: 'system_admin' });
  try {
    await ui.settle();
    const legacy = ['directory', 'organisation', 'checkins', 'tasks', 'accounts', 'assets', 'subscriptions', 'analytics'];
    assert.deepEqual(ui.tabs().options.map(option => option.value), [...legacy, 'performance']);
    for (const tab of legacy) {
      const tree = ui.selectTab(tab);
      assert.equal(ui.tabs().value, tab);
      assert.equal(nodes(tree).filter(node => node.type === 'performance-spy').length, 0);
      assert.equal(nodes(tree).filter(node => node.props?.role === 'tabpanel').length, 1);
    }
    assert.equal(ui.unmounts.length, 1);
  } finally { ui.cleanup(); }
});

test('same-actor capability scope A to B to A uses distinct authoritative load epochs', async () => {
  let currentCapabilities = capabilities('admin', personId);
  const ui = shell({ role: 'admin', roleResult: async () => ({ ok: true, capabilities: currentCapabilities }) });
  try {
    await ui.settle();
    const keys = [ui.people().renderPerformanceReviews.key];
    for (const canManageAssets of [false, true]) {
      currentCapabilities = { ...capabilities('admin', personId), can_manage_assets: canManageAssets };
      const invalidating = ui.people().renderEmployeeDirectory.props.onRecordsChanged();
      ui.render();
      assert.equal(ui.people(), undefined);
      await invalidating;
      await ui.settle();
      keys.push(ui.people().renderPerformanceReviews.key);
    }
    assert.equal(new Set(keys).size, 3);
    assert.equal(ui.mounts.length, 3);
    assert.equal(ui.unmounts.length, 2);
  } finally { ui.cleanup(); }
});

test('SSR shell keys bind the actual Auth actor even when two sessions have the same person capability DTO', async () => {
  const a = await home({ flag: 'true' });
  const b = await home({ flag: 'true', user: { id: '91000000-0000-4000-8000-000000000002' } });
  assert.notEqual(a.tree.key, b.tree.key);
});
