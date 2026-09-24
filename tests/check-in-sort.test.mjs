import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Load only the local sorting helpers; the components themselves need a browser.
function loadSort(file) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const helpers = [];
  ts.forEachChild(source, (node) => {
    if (ts.isFunctionDeclaration(node) && ['nameFor', 'nextDueDate', 'sortRecords'].includes(node.name?.text)) {
      helpers.push(node.getText(source));
    }
  });
  const code = ts.transpileModule(helpers.join('\n'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(`${code}\nreturn sortRecords;`)();
}

const record = (fullName, startDate, dueDate) => {
  const [firstName, lastName] = fullName.split(' ');
  return {
    fullName, firstName, lastName, startDate,
    reminders: dueDate ? [{ status: 'scheduled', dueDate }] : [],
  };
};

for (const file of ['src/components/check-in-register.tsx', 'src/components/check-in-workspace.tsx']) {
  test(`${file} orders equal dates by name regardless of input order`, () => {
    const sortRecords = loadSort(file);
    const records = [
      record('Casey Synthetic', '2026-09-01', '2026-10-05'),
      record('Avery Synthetic', '2026-09-01', '2026-10-05'),
      record('Blake Synthetic', '2026-09-08', '2026-10-01'),
      record('Drew Synthetic', '', null),
    ];
    const names = (sorted) => sorted.map((item) => item.fullName);
    for (const input of [records, [...records].reverse()]) {
      assert.deepEqual(names(sortRecords(input, 'start')), ['Blake Synthetic', 'Avery Synthetic', 'Casey Synthetic', 'Drew Synthetic']);
      assert.deepEqual(names(sortRecords(input, 'due')), ['Blake Synthetic', 'Avery Synthetic', 'Casey Synthetic', 'Drew Synthetic']);
    }
  });
}
