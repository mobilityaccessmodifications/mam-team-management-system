import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync('src/components/leave-demo.tsx', 'utf8');
const ast = ts.createSourceFile('leave.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function load(name) {
  let found;
  ts.forEachChild(ast, (node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node; });
  assert(found, name);
  const code = ts.transpileModule(found.getText(ast), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  return new Function(`${code}\nreturn ${name};`)();
}

const resolveParent = load('resolveOrganisationParent');
const nextHiddenParent = load('nextHiddenOrganisationParent');
// A scheduler really reports to the hidden "Scheduling team" unit, which the
// chart displays as reporting to the visible Team Leader.
const hiddenUnit = 'scheduling-unit';
const teamLeader = 'team-leader';
const otherManager = 'other-manager';

test('editing a person under a hidden unit keeps the real parent', () => {
  const parentId = resolveParent(hiddenUnit, teamLeader, teamLeader, undefined);
  assert.equal(parentId, hiddenUnit);
  assert.equal(nextHiddenParent(hiddenUnit, teamLeader, parentId, undefined), undefined);
});

test('moving a person out of a hidden unit and back (Undo) restores the unit', () => {
  const moved = resolveParent(hiddenUnit, teamLeader, otherManager, undefined);
  assert.equal(moved, otherManager);
  const remembered = nextHiddenParent(hiddenUnit, teamLeader, moved, undefined);
  assert.deepEqual(remembered, { visibleParentId: teamLeader, parentId: hiddenUnit });

  // A later unrelated move keeps the memory; returning to the Team Leader restores the unit.
  assert.equal(resolveParent(otherManager, otherManager, 'third-manager', remembered), 'third-manager');
  assert.deepEqual(nextHiddenParent(otherManager, otherManager, 'third-manager', remembered), remembered);
  const restored = resolveParent('third-manager', 'third-manager', teamLeader, remembered);
  assert.equal(restored, hiddenUnit);
  assert.equal(nextHiddenParent('third-manager', 'third-manager', restored, remembered), undefined);
});

test('people with visible parents keep the chart-selected reporting line', () => {
  assert.equal(resolveParent(teamLeader, teamLeader, teamLeader, undefined), teamLeader);
  assert.equal(resolveParent(teamLeader, teamLeader, otherManager, undefined), otherManager);
  assert.equal(nextHiddenParent(teamLeader, teamLeader, otherManager, undefined), undefined);
  assert.equal(resolveParent(null, null, null, undefined), null);
});
