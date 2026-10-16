import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export function loadUatSafety(environment = process.env, sourceRoot = fileURLToPath(new URL('../../', import.meta.url))) {
  const code = ts.transpileModule(readFileSync(path.join(sourceRoot, 'src/lib/uat-safety.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', 'process', code)(
    id => { throw new Error(`Unexpected pure-policy import: ${id}`); },
    mod, mod.exports, { env: environment },
  );
  return mod.exports;
}
