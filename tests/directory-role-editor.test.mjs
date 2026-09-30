import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function editorHarness(role = 'employee', mode = 'edit') {
  const state = [];
  let cursor = 0;
  const calls = [];
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
    if (id === '@/app/people/actions') return { updateEmployeeDirectoryRole: async (input) => { calls.push(input); return input.role; } };
    if (id.endsWith('.css')) return new Proxy({}, { get: (_, key) => key });
    if (id === '@/lib/employee-teams') return { EMPLOYEE_TEAMS: [] };
    if (id.startsWith('@/')) return {};
    return require(id);
  }, mod, mod.exports);
  const props = {
    editor: { mode, personId: '10000000-0000-4000-8000-000000000001', draft: { assetTags: [], workingWeekdays: null, workingDayTimes: [], isActive: true } },
    currentRecord: { isActive: true }, role, roleLoaded: true, onRoleSaved: (saved) => { props.role = saved; },
  };
  return { calls, render: () => { cursor = 0; return mod.exports.EmployeeEditor(props); } };
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
test('employment selector offers Overseas without removing existing choices', () => {
  const options = nodes(editorHarness().render()).filter((node) => node.type === 'option');
  for (const value of ['abn', 'casual', 'full_time', 'part_time', 'overseas']) assert.ok(options.some((node) => node.props.value === value), value);
  assert.equal(text(options.find((node) => node.props.value === 'overseas')), 'Overseas');
});

test('creating an employee does not offer Role editing', () => {
  const tree = editorHarness(null, 'create').render();
  assert.ok(!text(tree).includes('Role impact'));
  assert.ok(!nodes(tree).some((node) => node.type === 'button' && text(node) === 'Role'));
});
