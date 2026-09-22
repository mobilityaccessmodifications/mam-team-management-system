import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ts = require("typescript");

export function loadAssetTestModule(path, imports = {}) {
  const source = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const loadedModule = { exports: {} };
  new Function("require", "module", "exports", source)((id) => id in imports ? imports[id] : require(id), loadedModule, loadedModule.exports);
  return loadedModule.exports;
}

export function loadAssetQrModule() {
  return loadAssetTestModule("src/lib/asset-qr.ts");
}
