import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
export const actorId = '11000000-0000-4000-8000-000000000001';
export const targetId = '11000000-0000-4000-8000-000000000002';
export const fields = ['is_super_admin','can_manage_accounts','can_view_employee_directory','can_manage_employee_directory','can_view_organisation_chart','can_edit_organisation_chart','can_change_employee_view','can_view_check_in_workspace','can_manage_assets','can_view_subscription_register','can_manage_subscriptions','can_manage_subscription_credentials','can_manage_subscription_credential_grants','can_manage_subscription_management_grants','can_manage_roles','can_manage_analytics_api','can_import_payroll_balances','payroll_comparison_only','can_manage_leave_balances','can_view_all_leave_requests','can_review_leave_workspace','can_approve_employment_decisions'];
export function capabilities(role = 'admin', personId = targetId) {
  const row = { app_role: role, person_id: personId, account_status: 'active', ...Object.fromEntries(fields.map(key => [key, false])) };
  if (role === 'admin' || role === 'system_admin') for (const key of fields) row[key] = true;
  for (const key of ['is_super_admin','can_manage_roles','can_change_employee_view','can_manage_analytics_api','can_manage_subscription_credential_grants','can_manage_subscription_management_grants']) row[key] = role === 'system_admin';
  row.payroll_comparison_only = role === 'account';
  if (role === 'account') for (const key of ['can_import_payroll_balances','can_view_all_leave_requests']) row[key] = true;
  if (role === 'manager') for (const key of ['can_view_employee_directory','can_view_organisation_chart','can_view_check_in_workspace','can_view_subscription_register','can_review_leave_workspace']) row[key] = true;
  return row;
}
export function loadModule(file, overrides = {}, cache = new Map()) {
  if (cache.has(file)) return cache.get(file).exports;
  if (!existsSync(file)) return {};
  const mod = { exports: {} }; cache.set(file, mod);
  const source = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  new Function('require','module','exports',source)((id) => {
    if (Object.hasOwn(overrides, id)) return overrides[id];
    if (id === 'server-only') return {};
    if (id.endsWith('.css')) return { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) };
    if (id.startsWith('@/')) return loadModule('src/'+id.slice(2)+'.ts', overrides, cache);
    return require(id);
  }, mod, mod.exports);
  return mod.exports;
}
export function portalRoleDependencies(client) {
  return {
    '@/lib/portal-role-capabilities': loadModule('src/lib/portal-role-capabilities.ts'),
    '@/lib/portal-role-access': loadModule('src/lib/portal-role-access.ts', { '@/lib/supabase/server': { createClient: async () => client } }),
  };
}
export function actionFixture({ target = capabilities(), actor = capabilities('system_admin', null), error = null, session = true, contactError = null } = {}) {
  const calls = [];
  const client = { auth: { getUser: async () => ({ data: { user: session ? { id: actorId } : null }, error: null }) }, async rpc(name, args) {
    calls.push({ name, args });
    if (name === 'get_portal_role_capabilities') return { data: error ? null : [args?.p_person_id ? target : actor], error };
    if (name === 'can_change_employee_view' || name === 'can_manage_roles' || name === 'can_manage_portal_accounts') return { data: actor.is_super_admin, error: null };
    if (name === 'get_selected_employee_profile_for_hr') return { data: [{ person_id: targetId, full_name: 'Synthetic Target', position_title: 'Tester', company_key: 'mam', detail_version: 1 }], error: contactError };
    if (name === 'get_selected_employee_profile_access_role_for_preview') return { data: target.app_role, error: null };
    throw new Error('Unexpected synthetic RPC '+name);
  } };
  const overrides = {
    '@/lib/supabase/server': { createClient: async () => client },
    '@/lib/employee-directory': { requireEmployeeDirectoryManager: async () => ({ supabase: client }), requireDirectoryMutationManager: async () => ({ supabase: client }) },
    'next/cache': { revalidatePath() {} },
  };
  return { calls, client, load: file => loadModule(file, overrides), overrides };
}
export function requireAction(module, name) {
  assert.equal(typeof module[name], 'function', name+' must be a real Server Action');
  return module[name];
}
export const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];
export const text = tree => tree == null || typeof tree === 'boolean' ? '' : typeof tree !== 'object' ? String(tree) : Array.isArray(tree) ? tree.map(text).join('') : text(tree.props?.children);
export const flush = () => new Promise(resolve => setImmediate(resolve));
export const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
export function hooksHarness(React) {
  let cursor = 0, dirty = false;
  const hooks = [], effects = [];
  const take = initial => { const index = cursor++; return [index, hooks[index] ??= initial]; };
  const depsEqual = (a,b) => a && b && a.length === b.length && a.every((value,index) => Object.is(value,b[index]));
  return {
    react: { ...React,
      useState(initial) { const [index,state] = take({ value: typeof initial === 'function' ? initial() : initial }); return [state.value, next => { const value = typeof next === 'function' ? next(hooks[index].value) : next; if (!Object.is(value, hooks[index].value)) dirty = true; hooks[index].value = value; }]; },
      useRef(initial) { return take({ current: initial })[1]; },
      useMemo(callback,deps) { const [,state] = take({}); if (!depsEqual(state.deps,deps)) { state.value = callback(); state.deps = deps; } return state.value; },
      useCallback(callback,deps) { const [,state] = take({}); if (!depsEqual(state.deps,deps)) { state.value = callback; state.deps = deps; } return state.value; },
      useEffect(callback,deps) { const [,state] = take({}); if (!depsEqual(state.deps,deps)) { state.deps = deps; effects.push(() => { state.cleanup?.(); state.cleanup = callback(); }); } },
      useLayoutEffect(callback,deps) { const [,state] = take({}); if (!depsEqual(state.deps,deps)) { state.deps = deps; effects.push(() => { state.cleanup?.(); state.cleanup = callback(); }); } },
      useId() { return take({ value: 'hook-'+cursor })[1].value; },
    },
    begin() { cursor = 0; dirty = false; },
    effects() { for (const effect of effects.splice(0)) effect(); },
    dirty() { return dirty; },
  };
}
