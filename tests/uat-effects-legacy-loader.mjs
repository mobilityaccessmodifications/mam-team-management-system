import Module from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const filename = fileURLToPath(new URL('../src/lib/uat-safety.ts', import.meta.url));
const loaded = { exports: {} };
const code = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
new Function('module', 'exports', code)(loaded, loaded.exports);
const original = Module._load;
Module._load = function (name, ...args) {
  if (name === '@/lib/uat-safety') return loaded.exports;
  return Reflect.apply(original, this, [name, ...args]);
};
