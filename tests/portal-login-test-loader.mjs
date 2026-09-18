import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

export function loadPortalLoginModule() {
  const source = ts.transpileModule(readFileSync("src/lib/portal-login.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const moduleUnderTest = { exports: {} };
  new Function("module", "exports", source)(moduleUnderTest, moduleUnderTest.exports);
  return moduleUnderTest.exports;
}
