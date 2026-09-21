import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
function load(path, extra = '') {
  const loaded = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path, 'utf8') + extra, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  new Function('require', 'module', 'exports', code)(id => id === '@/lib/organisation-layout' ? helpers : {}, loaded, loaded.exports);
  return loaded.exports;
}
const helpers = load('src/lib/organisation-layout.ts');
const { layoutForest } = load('src/components/organisation-tree.tsx', '\nexport { layoutForest };');
const node = (id, position, children = [], extra = {}) => ({ id, name: `Example ${id}`, position, company: 'mam', reportsTo: null, children, ...extra });
const members = (role, count, parent) => Array.from({length: count}, (_, i) => node(`${role}-${i}`, role, [], { reportsTo: parent }));
const teams = ['Scheduling', 'Trades', 'Estimating', 'Admin'].map((name, i) => node(`team-${i}`, '', members(['Scheduler', 'Installer', 'Estimator', 'Administrator'][i], [3,6,4,3][i], `team-${i}`), { name: `${name} team`, kind: 'org_unit', reportsTo: 'leader' }));
const leader = node('leader', 'Minor Mods Team Leader', [...teams, node('empty', '', [], {name: 'CSO team', kind: 'org_unit'})]);
test('Minor default shows four ordered vertical columns without altering reporting records', () => {
  const original = JSON.stringify(leader);
  const layout = layoutForest([leader], new Set(), {});
  assert.equal(layout.nodes.length, 17);
  let lastX = -Infinity;
  for (const team of teams) {
    const cards = team.children.map(person => layout.nodes.find(card => card.node.id === person.id));
    assert.ok(cards[0].x > lastX);
    lastX = cards[0].x;
    assert.ok(cards.every(card => card.x === lastX));
    cards.slice(1).forEach((card,i) => assert.ok(card.y >= cards[i].y + cards[i].height));
    cards.forEach(card => assert.equal(card.node.reportsTo, team.id));
  }
  assert.equal(JSON.stringify(leader), original);
});
test('Equipsy defaults vertical, with horizontal override and return to default', () => {
  const root = node('eq', 'Team Leader', members('Support', 3, 'eq').map(person => ({...person, company: 'equipsy'})), {company: 'equipsy'});
  const positions = (mode, overrides = {}) => layoutForest([root], new Set(), overrides, mode).nodes.slice(1);
  assert.equal(new Set(positions('default').map(p => p.x)).size, 1);
  assert.equal(new Set(positions('horizontal').map(p => p.y)).size, 1);
  assert.equal(new Set(positions('default', {eq: 'horizontal'}).map(p => p.y)).size, 1);
  assert.deepEqual(positions('default'), positions('default', {}));
});
test('Manual layouts preserve structural nodes; collapse and unknown roles remain safe', () => {
  assert.equal(layoutForest([leader], new Set(), {}, 'grouped').nodes.length, 22);
  assert.equal(layoutForest([leader], new Set(['leader']), {}).nodes.length, 1);
  const expanded = {...leader, children: [...leader.children, node('special', 'Specialist')]};
  assert.ok(layoutForest([expanded], new Set(), {}).nodes.some(p => p.node.id === 'special'));
});
