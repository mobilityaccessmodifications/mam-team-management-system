import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { loadModule, hooksHarness, nodes, text, flush, deferred } from './helpers/contact-lifetime-harness.mjs';
import { draft } from './helpers/directory-action-harness.mjs';
const React = createRequire(import.meta.url)('react');
const warehouseManager = '10000000-0000-4000-8000-000000000002';
const majorManager = '10000000-0000-4000-8000-000000000003';
const records = [
  { ...draft, personId: warehouseManager, fullName: 'Warehouse Synthetic', firstName: 'Warehouse', managerId: majorManager, managerName: 'Major Synthetic', personVersion: 1, detailVersion: 1 },
  { ...draft, personId: majorManager, fullName: 'Major Synthetic', firstName: 'Major', managerId: null, managerName: '', personVersion: 1, detailVersion: 1 },
];
function fixture(resolve = async ({ teamName }) => ({ status: 'valid', managerId: teamName === 'Warehouse' ? warehouseManager : majorManager, managerName: teamName === 'Warehouse' ? 'Warehouse Synthetic' : 'Major Synthetic' })) {
  const parent = hooksHarness(React), child = hooksHarness(React), calls = [], mutations = [];
  let frame = parent, tree, editorTree, editor;
  const react = { ...React };
  for (const name of ['useState','useRef','useMemo','useCallback','useEffect','useLayoutEffect','useId']) react[name] = (...args) => frame.react[name](...args);
  const { EmployeeDirectory } = loadModule('src/components/employee-directory.tsx', {
    react,
    '@/app/people/actions': {
      getEmployeeTeamManagerDefault: async input => { calls.push(input); return resolve(input); },
      createEmployeeDirectoryRecord: async input => { mutations.push(input); return { error: 'Synthetic rejected write' }; },
      updateEmployeeDirectoryRecord: async input => { mutations.push(input); return { error: 'Synthetic rejected write' }; },
      listEmployeeDirectoryRoles: async () => ({}),
    },
    '@/components/ui/modal-backdrop': { ModalBackdrop() {} },
    '@/components/employee-device-assignments': { EmployeeDeviceAssignments() {} },
    '@/components/ui/motion-loader': { MotionLoader() {} },
    '@/components/ui/use-dialog-focus': { useDialogFocus() {} },
    '@/components/ui/use-media-query': { useMediaQuery: () => false },
  });
  function render() {
    frame = parent; parent.begin(); tree = EmployeeDirectory({ initialRecords: records }); parent.effects();
    editor = nodes(tree).find(node => node.type?.name === 'EmployeeEditor');
    if (editor) { frame = child; child.begin(); editorTree = editor.type(editor.props); child.effects(); }
    else editorTree = null;
    return editorTree;
  }
  const button = label => nodes(tree).find(node => node.type === 'button' && text(node).trim() === label);
  render();
  return { calls, mutations, render, async settle() { await flush(); render(); await flush(); render(); },
    create() { button('Add employee').props.onClick(); render(); },
    change(key,value) { editor.props.onChange(key,value); render(); },
    select: () => nodes(editorTree).find(node => node.type === 'select' && node.props['aria-label'] === 'Reports to'),
    submit: () => editor.props.onSubmit({ preventDefault() {} }),
    close() { editor.props.onClose(); render(); },
    edit() { nodes(tree).find(node => node.type?.name === 'EmployeeDirectoryList').props.onSelect(records[0]); render(); },
    tree: () => editorTree, props: () => editor.props, button,
  };
}
test('new employee shows its authoritative Team Manager without making the preview an explicit override', async () => {
  const ui = fixture(); ui.create(); ui.change('teamName','Warehouse'); await ui.settle();
  const select = ui.select();
  assert.ok(select, 'New employee must show its resolved Reports to selection');
  assert.equal(select.props.value, '');
  assert.match(text(select), /Warehouse Synthetic/);
  assert.equal(ui.props().editor.draft.managerId, null);
  assert.deepEqual(ui.calls, [{ company: 'mam', teamName: 'Warehouse' }]);
});

test('Team switching rejects a delayed old preview and submits only the current Team default', async () => {
  const old = deferred();
  const ui = fixture(({ teamName }) => teamName === 'Warehouse' ? old.promise
    : Promise.resolve({ status: 'valid', managerId: majorManager, managerName: 'Major Synthetic' }));
  ui.create(); ui.change('teamName','Warehouse'); ui.change('teamName','Major'); await ui.settle();
  old.resolve({ status: 'valid', managerId: warehouseManager, managerName: 'Warehouse Synthetic' }); await ui.settle();
  assert.match(text(ui.select()), /Team Manager: Major Synthetic/);
  assert.doesNotMatch(text(nodes(ui.select()).find(node => node.type === 'option' && node.props.value === '')), /Warehouse/);
  await ui.submit();
  assert.equal(ui.mutations.length, 1); assert.equal(ui.mutations[0].teamName, 'Major'); assert.equal(ui.mutations[0].managerId, null);
});
test('A to B to A and close/reopen cannot reuse an old same-Team response', async () => {
  for (const reopen of [false, true]) {
    const old = deferred(); let warehouseCalls = 0;
    const ui = fixture(({ teamName }) => teamName === 'Warehouse' && ++warehouseCalls === 1 ? old.promise
      : Promise.resolve({ status: 'valid', managerId: majorManager, managerName: 'Current Synthetic' }));
    ui.create(); ui.change('teamName','Warehouse');
    if (reopen) { ui.close(); ui.create(); } else ui.change('teamName','Major');
    ui.change('teamName','Warehouse'); await ui.settle();
    old.resolve({ status: 'valid', managerId: warehouseManager, managerName: 'Retired Synthetic' }); await ui.settle();
    assert.match(text(ui.select()), /Team Manager: Current Synthetic/);
    assert.doesNotMatch(text(ui.select()), /Retired Synthetic/);
  }
});
test('a valid explicit selection survives a delayed default preview but is reset after a company or Team switch', async () => {
  const held = deferred(); const ui = fixture(() => held.promise);
  ui.create(); ui.change('teamName','Warehouse'); ui.select().props.onChange({ target: { value: majorManager } }); ui.render();
  held.resolve({ status: 'valid', managerId: warehouseManager, managerName: 'Warehouse Synthetic' }); await ui.settle();
  assert.equal(ui.select().props.value, majorManager); await ui.submit(); assert.equal(ui.mutations[0].managerId, majorManager);
  ui.change('teamName','Major'); assert.equal(ui.props().editor.draft.managerId, null);
  ui.change('managerId',majorManager); ui.change('company','equipsy'); assert.equal(ui.props().editor.draft.managerId, null);
  assert.deepEqual(nodes(ui.select()).filter(node => node.type === 'option' && node.props.value).map(node => node.props.value), []);
});
test('missing config is visibly unassigned while invalid config and pending lookup require a valid override', async () => {
  const missing = fixture(async () => ({ status: 'missing', managerId: null, managerName: '' }));
  missing.create(); missing.change('teamName','Warehouse'); await missing.settle();
  assert.match(text(missing.select()), /saved unassigned/); await missing.submit(); assert.equal(missing.mutations[0].managerId, null);
  for (const response of [{ status: 'invalid', managerId: null, managerName: '' }, { error: 'Team Manager could not be checked.' }]) {
    const ui = fixture(async () => response); ui.create(); ui.change('teamName','Warehouse'); await ui.settle();
    await ui.submit(); assert.equal(ui.mutations.length, 0);
    assert.equal(nodes(ui.tree()).find(node => node.type === 'button' && node.props.type === 'submit').props.disabled, true);
    ui.change('managerId',majorManager); await ui.submit(); assert.equal(ui.mutations.length, 1);
  }
  const pending = fixture(() => deferred().promise); pending.create(); pending.change('teamName','Warehouse');
  await pending.submit(); assert.equal(pending.mutations.length, 0);
});
test('editing a historical employee never resolves or resets its manually chosen parent', async () => {
  const ui = fixture(); ui.edit(); assert.equal(ui.select(), undefined);
  ui.change('teamName','Warehouse'); ui.change('positionTitle','Edited Synthetic'); await ui.settle();
  assert.deepEqual(ui.calls, []); await ui.submit(); assert.equal(ui.mutations[0].managerId, majorManager);
});
