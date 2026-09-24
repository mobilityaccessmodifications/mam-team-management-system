import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.tsx?$/.test(entry.name) ? [file] : [];
  });
}

const isFunction = (node) => ts.isArrowFunction(node) || ts.isFunctionExpression(node);
const isStateSetterCall = (node) => ts.isCallExpression(node)
  && ts.isIdentifier(node.expression) && /^set[A-Z]/.test(node.expression.text);

// React clears event.currentTarget after a handler returns. An updater passed
// to a state setter can run later, during render, and would then throw.
function currentTargetReadsInsideUpdaters(file, text = readFileSync(file, 'utf8')) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const offenders = [];
  const visit = (node, inSetterArgument, inUpdater) => {
    if (inUpdater && ts.isPropertyAccessExpression(node) && node.name.text === 'currentTarget') {
      offenders.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    }
    if (isStateSetterCall(node)) {
      visit(node.expression, false, inUpdater);
      node.arguments.forEach((argument, index) => visit(argument, index === 0, inUpdater));
      return;
    }
    const entersUpdater = inSetterArgument && isFunction(node);
    ts.forEachChild(node, (child) => visit(child, inSetterArgument && !entersUpdater, inUpdater || entersUpdater));
  };
  visit(source, false, false);
  return offenders;
}

test('state updaters never read event.currentTarget after the handler returns', () => {
  assert.deepEqual(sourceFiles('src').flatMap((file) => currentTargetReadsInsideUpdaters(file)), []);
});

test('the updater check flags deferred reads and allows synchronous ones', () => {
  const synthetic = [
    'const onChange = (event) => {',
    '  const checked = event.currentTarget.checked;',
    '  setSelected((current) => checked ? current : current);',
    '  setSelected((current) => event.currentTarget.checked ? current : current);',
    '  setOpen(event.currentTarget.open ? "id" : (current) => current);',
    '};',
  ].join('\n');
  assert.deepEqual(currentTargetReadsInsideUpdaters('synthetic.tsx', synthetic), ['synthetic.tsx:4']);
});
