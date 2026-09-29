import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const mod = { exports: {} };
new Function('exports', ts.transpileModule(readFileSync('src/lib/employee-teams.ts','utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(mod.exports);
test('the operation and accounts team replaces MAM admin without changing the other choices', () => {
  assert.deepEqual(mod.exports.EMPLOYEE_TEAMS, ['Operation & Accounts','Management','Major','Minor','Warehouse','Equipsy']);
  for (const team of mod.exports.EMPLOYEE_TEAMS) assert.equal(mod.exports.requireEmployeeTeam(team), team);
  for (const value of ['',null,undefined,'MAM admin','Finance','Management Team','warehouse',{}]) assert.throws(() => mod.exports.requireEmployeeTeam(value), /Choose a team/);
});
