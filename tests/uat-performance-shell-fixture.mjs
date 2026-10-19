import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as React from 'react';
import ts from 'typescript';
import { capabilities, deferred, flush, loadModule, nodes, text } from './helpers/unified-role-harness.mjs';

export { capabilities, deferred, nodes, text };
export const actorId = '91000000-0000-4000-8000-000000000001';
export const personId = '92000000-0000-4000-8000-000000000001';
export const secondId = '92000000-0000-4000-8000-000000000002';

function imports(file) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return source.statements.filter(ts.isImportDeclaration).filter(row => !row.importClause?.isTypeOnly).map(row => ({
    id: row.moduleSpecifier.text,
    names: (row.importClause?.namedBindings?.elements ?? []).filter(item => !item.isTypeOnly).map(item => (item.propertyName ?? item.name).text),
  }));
}

export function shell({ role = 'employee', enabled = true, actor = capabilities(role, role === 'system_admin' ? null : personId), authId = actorId, currentPersonId = actor?.person_id ?? undefined, initialTab = 'performance', initialView = 'people', roleResult, organisationError = null, signOutPending } = {}) {
  let dirty = true, current, sequence = 0;
  const instances = new Map(), effects = [], timers = new Map(), callbacks = new Map(), authCallbacks = new Set();
  const calls = [], mounts = [], unmounts = [], dynamicLoads = [], observed = new Map();
  const props = { actorCapabilities: actor, authActorId: authId, performanceReviewEnabled: enabled, currentPersonId, isNonRosterSystemAdmin: role === 'system_admin' && !currentPersonId, canViewTeamCalendar: true, initialNavigation: { view: initialView, section: 'requests', peopleSection: initialTab } };
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const take = initialize => {
    const index = current.cursor++;
    return current.hooks[index] ??= initialize();
  };
  const effect = (callback, deps) => {
    const state = take(() => ({}));
    if (!same(state.deps, deps)) {
      state.deps = deps;
      effects.push(() => { state.cleanup?.(); state.cleanup = callback(); });
    }
  };
  const react = {
    ...React,
    useState(initial) {
      const state = take(() => ({ value: typeof initial === 'function' ? initial() : initial }));
      return [state.value, next => { const value = typeof next === 'function' ? next(state.value) : next; if (!Object.is(state.value, value)) dirty = true; state.value = value; }];
    },
    useRef: initial => take(() => ({ current: initial })),
    useMemo(callback, deps) { const state = take(() => ({})); if (!same(state.deps, deps)) { state.value = callback(); state.deps = deps; } return state.value; },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
    useEffect: effect,
    useLayoutEffect: effect,
    useId: () => take(() => ({ id: 'shell-hook-' + ++sequence })).id,
  };
  function PerformanceSpy(spyProps) {
    assert.deepEqual(Object.keys(spyProps), [], 'the native review workspace takes no identity/role/preview props');
    const lifetime = current.path;
    react.useEffect(() => { mounts.push(lifetime); return () => unmounts.push(lifetime); }, []);
    return React.createElement('performance-spy');
  }
  globalThis.fetch = async () => assert.fail('Shell regressions must stay offline');
  globalThis.window = {
    setTimeout(callback, delay) { const id = ++sequence; if (delay < 1000) timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => ++sequence, clearInterval() {},
    addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }), scrollTo() {},
    location: { replace: path => calls.push(['navigation', path]) },
  };
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, getElementById: () => null };
  const rows = [personId, secondId].map((id, index) => ({ id, node_kind: 'person', company_key: 'mam', full_name: 'Synthetic ' + (index ? 'B' : 'A'), position_title: 'Tester', parent_id: null, sort_order: index, is_active: true, version: 1 }));
  const client = {
    auth: {
      getUser: async () => { calls.push(['auth-user']); return { data: { user: authId ? { id: authId } : null }, error: null }; },
      onAuthStateChange: callback => { calls.push(['auth-subscribe']); authCallbacks.add(callback); return { data: { subscription: { unsubscribe: () => { calls.push(['auth-unsubscribe']); authCallbacks.delete(callback); } } } }; },
      signOut: async () => { calls.push(['browser-signout']); return signOutPending ? await signOutPending.promise : { error: null }; },
    },
    from(table) {
      assert.equal(table, 'internal_org_people'); calls.push(['organisation']);
      const query = { select: () => query, order: () => query, then: callback => Promise.resolve({ data: rows, error: organisationError }).then(callback) };
      return query;
    },
    rpc: async name => {
      calls.push(['rpc', name]);
      assert.ok(['can_edit_internal_org', 'can_manage_employee_directory'].includes(name), 'Unexpected RPC ' + name);
      return { data: actor?.can_manage_employee_directory === true, error: null };
    },
    channel(name) { const channel = { on: (_event, _filter, callback) => { callbacks.set(name, callback); return channel; }, subscribe: () => channel }; return channel; },
    removeChannel() {},
  };
  const overrides = {
    react, 'next/link': 'link',
    '@/lib/supabase/client': { createClient: () => client },
    '@/lib/supabase/config': { isSupabaseConfigured: () => true },
    '@/components/ui/use-dialog-focus': { useDialogFocus() {} },
  };
  for (const file of ['src/components/leave-demo.tsx', 'src/components/people-operations-demo.tsx']) {
    for (const row of imports(file)) {
      if (row.id.startsWith('@/app/')) overrides[row.id] = { ...overrides[row.id], ...Object.fromEntries(row.names.map(name => [name, () => assert.fail('Unexpected action ' + name)])) };
      else if (row.id.startsWith('@/components/') && !row.id.endsWith('.css') && !Object.hasOwn(overrides, row.id)) overrides[row.id] = Object.fromEntries(row.names.map(name => [name, name]));
    }
  }
  Object.assign(overrides['@/app/login/actions'], { signOut: async () => { calls.push(['server-signout']); if (signOutPending) await signOutPending.promise; } });
  Object.assign(overrides['@/app/roles/actions'], { getPortalRoleCapabilities: async id => {
    calls.push(['capabilities', id]);
    return roleResult ? await roleResult(id) : { ok: true, capabilities: id ? capabilities('admin', id) : actor };
  } });
  Object.assign(overrides['@/app/profile/actions'], {
    getCurrentEmployeeSelfProfile: async () => ({ personId, name: 'Synthetic A', title: 'Tester', company: 'mam', detailVersion: 1 }),
    getSelectedEmployeeProfile: async id => ({ personId: id, name: id === personId ? 'Synthetic A' : 'Synthetic B', title: 'Tester', company: 'mam', detailVersion: 1 }),
  });
  Object.assign(overrides['@/app/accounts/actions'], { listPortalAccounts: async () => { calls.push(['accounts']); return []; } });
  Object.assign(overrides['@/app/leave/actions'], { getLeaveWorkspaceData: async id => {
    calls.push(['leave', id]);
    return { requests: [], attachments: [], calendarEntries: [], birthdayEntries: [], checkInEntries: [], subscriptionReviewEntries: [], payrollBalanceReminderEntries: [], employmentType: 'full_time', hasPaidLeaveEntitlement: true, availableLeaveTypes: ['Annual leave'], isProfilePreview: Boolean(id), priority: { people: [], canManageBalances: actor?.can_manage_leave_balances === true } };
  } });
  Object.assign(overrides['@/app/work-schedule/actions'], { loadEmployeeWorkScheduleWorkspace: async id => {
    calls.push(['schedule', id]); return { ok: true, workspace: { activePersonId: id ?? currentPersonId ?? null, isProfilePreview: Boolean(id), history: [], reviews: [] } };
  } });
  const people = loadModule('src/components/people-operations-demo.tsx', overrides);
  overrides['next/dynamic'] = (loader, options) => {
    const path = loader.toString().match(/require\(["']([^"']+)["']\)/)?.[1];
    assert.ok(path, 'Dynamic fixture must resolve the actual module path');
    dynamicLoads.push({ path, loading: typeof options?.loading });
    if (path === '@/components/people-operations-demo') return people.PeopleOperationsDemo;
    if (path === '@/components/performance-review-workspace') return PerformanceSpy;
    return path.split('/').at(-1);
  };
  const { LeaveDemo } = loadModule('src/components/leave-demo.tsx', overrides);
  let tree;
  function renderNode(node, path, seen) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((child, index) => renderNode(child, path + ':' + index, seen));
    if (node.type === React.Fragment) return renderNode(node.props.children, path + ':fragment', seen);
    if (typeof node.type === 'function') {
      const id = path + ':' + node.type.name + ':' + (node.key ?? '');
      seen.add(id);
      let instance = instances.get(id);
      if (!instance) { instance = { cursor: 0, hooks: [], path: id }; instances.set(id, instance); }
      instance.cursor = 0; current = instance;
      observed.set(node.type.name, node);
      const output = node.type(node.props);
      return renderNode(output, id, seen);
    }
    return { ...node, props: { ...node.props, children: renderNode(node.props?.children, path + ':' + String(node.type), seen) } };
  }
  const render = () => {
    dirty = false; observed.clear();
    const seen = new Set();
    tree = renderNode(React.createElement(LeaveDemo, props), 'root', seen);
    for (const [id, instance] of instances) if (!seen.has(id)) {
      for (const hook of instance.hooks) hook.cleanup?.();
      instances.delete(id);
    }
    for (const run of effects.splice(0)) run();
    return tree;
  };
  const ui = {
    calls, mounts, unmounts, dynamicLoads, props, render, observed,
    async settle() {
      for (let round = 0; round < 12; round++) {
        render();
        for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
        await flush();
        if (!dirty && timers.size === 0) break;
      }
      return render();
    },
    people: () => observed.get('PeopleOperationsDemo')?.props,
    tabs: () => nodes(tree).find(node => node.type === 'MotionTabs' && node.props.ariaLabel === 'People sections')?.props,
    selectTab(value) { const tabs = ui.tabs(); assert.ok(tabs?.options.some(option => option.value === value), 'Tab unavailable: ' + value); tabs.onValueChange(value); return render(); },
    navigate(view) { const button = nodes(tree).find(node => node.type === 'button' && text(node).trim() === (view === 'people' ? 'People' : 'Home')); assert.ok(button, 'Navigation unavailable: ' + view); button.props.onClick(); return render(); },
    preview(id) {
      const trigger = nodes(tree).find(node => node.type === 'button' && /Change profile/.test(node.props['aria-label'] ?? ''));
      assert.ok(trigger, 'Change profile must use the real shell control'); trigger.props.onClick(); render();
      const label = id === '' ? 'Super Admin' : id === secondId ? 'Synthetic B' : 'Synthetic A';
      const button = nodes(tree).find(node => node.type === 'button' && String(node.props.className).includes('profilePickerOption') && text(node).startsWith(id === '' ? 'SA' + label : 'S' + (id === secondId ? 'B' : 'A') + label));
      assert.ok(button, 'Synthetic profile missing: ' + label); button.props.onClick(); return render();
    },
    auth(event, id) { for (const callback of authCallbacks) callback(event, id ? { user: { id } } : null); return render(); },
    invalidate() { assert.ok(callbacks.get('internal:organisation')); callbacks.get('internal:organisation')(); return render(); },
    cleanup() { for (const instance of instances.values()) for (const hook of instance.hooks) hook.cleanup?.(); instances.clear(); },
  };
  return ui;
}
