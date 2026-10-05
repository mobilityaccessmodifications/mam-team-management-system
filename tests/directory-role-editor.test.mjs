import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { loadModule } from './helpers/unified-role-harness.mjs';

const require = createRequire(import.meta.url);
function editorHarness(role = 'employee', mode = 'edit', canManageRoles = true, committed = false) {
  const state = [];
  let cursor = 0;
  const calls = [], invalidations = [];
  const react = { ...require('react'), useId: () => 'role-input', useState: (initial) => {
    const index = cursor++;
    if (!(index in state)) state[index] = initial;
    return [state[index], (value) => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
  } };
  const mod = { exports: {} };
  const source = ts.transpileModule(`${readFileSync('src/components/employee-directory.tsx', 'utf8')}\nexport { EmployeeEditor };`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  new Function('require', 'module', 'exports', source)((id) => {
    if (id === 'react') return react;
    if (id === '@/app/people/actions') return { updateEmployeeDirectoryRole: async (input) => { calls.push(input); return committed ? {committed:true,personId:input.personId,error:'Role was saved, but the directory could not be refreshed.'} : input.role; } };
    if (id.endsWith('.css')) return new Proxy({}, { get: (_, key) => key });
    if (id === '@/lib/employee-teams') return { EMPLOYEE_TEAMS: [] };
    if (id.startsWith('@/lib/portal-role')) return loadModule('src/'+id.slice(2)+'.ts');
    if (id.startsWith('@/')) return {};
    return require(id);
  }, mod, mod.exports);
  const props = {
    editor: { mode, personId: '10000000-0000-4000-8000-000000000001', draft: { assetTags: [], workingWeekdays: null, workingDayTimes: [], isActive: true } },
    currentRecord: { isActive: true }, canManageRoles, role, roleLoaded: true,onCommitted(){},onRoleCommitted:()=>invalidations.push('role'), onRoleSaved: (saved) => { props.role = saved; },
  };
  return { calls, invalidations, render: () => { cursor = 0; return mod.exports.EmployeeEditor(props); } };
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
function text(tree) {
  if (typeof tree === 'string') return tree;
  if (Array.isArray(tree)) return tree.map(text).join('');
  return tree?.props ? text(tree.props.children) : '';
}
test('role impact is hidden until Role editing is opened and role save remains separate', async () => {
  const harness = editorHarness();
  let tree = harness.render();
  assert.ok(!text(tree).includes('Role impact'));
  const button = nodes(tree).find((node) => node.type === 'button' && text(node) === 'Role');
  assert.ok(button, 'Role opens an explicit editor');
  button.props.onClick();
  tree = harness.render();
  assert.ok(text(tree).includes('Role impact'));
  const select = nodes(tree).find((node) => node.type === 'select' && node.props.id === 'role-input');
  select.props.onChange({ target: { value: 'manager' } });
  tree = harness.render();
  const save = nodes(tree).find((node) => node.type === 'button' && text(node) === 'Save role');
  assert.equal(save.props.type, 'button');
  save.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.calls, [{ personId: '10000000-0000-4000-8000-000000000001', role: 'manager', expectedRole: 'employee' }]);
  tree = harness.render();
  nodes(tree).find((node) => node.type === 'button' && text(node) === 'Role').props.onClick();
  assert.ok(!text(harness.render()).includes('Role impact'));
});
test('a known committed role save invalidates parent capabilities even when revalidation failed',async()=>{
  const ui=editorHarness('employee','edit',true,true);let tree=ui.render();
  nodes(tree).find(n=>n.type==='button' && text(n)==='Role').props.onClick();tree=ui.render();
  nodes(tree).find(n=>n.type==='select' && n.props['aria-label']==='Role').props.onChange({target:{value:'admin'}});tree=ui.render();
  nodes(tree).find(n=>n.type==='button' && text(n)==='Save role').props.onClick();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(ui.invalidations,['role']);
  assert.match(text(ui.render()),/Role was saved/);
});
test('employment selector offers Overseas without removing existing choices', () => {
  const options = nodes(editorHarness().render()).filter((node) => node.type === 'option');
  for (const value of ['abn', 'casual', 'full_time', 'part_time', 'overseas']) assert.ok(options.some((node) => node.props.value === value), value);
  assert.equal(text(options.find((node) => node.props.value === 'overseas')), 'Overseas');
});

test('Role editor offers exactly four ordinary roles with accurate permission cards; P0 is never assignable', () => {
  const ui = editorHarness(); let tree = ui.render();
  nodes(tree).find(n => n.type === 'button' && text(n) === 'Role').props.onClick(); tree = ui.render();
  const select = nodes(tree).find(n => n.type === 'select' && n.props['aria-label'] === 'Role');
  assert.deepEqual(nodes(select).filter(n => n.type === 'option').map(n => n.props.value), ['employee','manager','account','admin']);
  select.props.onChange({target:{value:'account'}}); tree = ui.render();
  assert.match(text(tree), /all-status leave/i);
  assert.match(text(tree), /existing evidence/i);
  assert.match(text(tree), /comparison-only/i);
  assert.match(text(tree), /Cannot/);
  assert.match(text(tree), /commit.*balances|balance.*writes/i);
  select.props.onChange({target:{value:'manager'}}); tree = ui.render();
  assert.match(text(tree), /separate.*subscription|subscription.*separate/i);
});
test('ordinary Admin and P0 target records never offer Role editing', () => {
  for (const [role,allowed] of [['admin',false],['system_admin',true]]) {
    const tree = editorHarness(role,'edit',allowed).render();
    assert.ok(!nodes(tree).some(n => n.type === 'button' && text(n) === 'Role'));
  }
});
test('creating an employee does not offer Role editing', () => {
  const tree = editorHarness(null, 'create').render();
  assert.ok(!text(tree).includes('Role impact'));
  assert.ok(!nodes(tree).some((node) => node.type === 'button' && text(node) === 'Role'));
});
