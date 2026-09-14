import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = readFileSync("src/components/people-operations-demo.tsx", "utf8");
const ast = ts.createSourceFile(
  "people-operations-demo.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

test("server-scoped tasks do not expose legacy lifecycle creation", () => {
  let initializer;

  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "showTaskAction") {
      initializer = node.initializer;
    }
    ts.forEachChild(node, visit);
  }

  visit(ast);
  assert.ok(initializer, "task action visibility should be declared");
  assert.match(
    initializer.getText(ast),
    /^!hasRealCheckInTasks\s*&&\s*canManage\s*&&\s*visibleSection\s*===\s*["']tasks["']$/,
    "legacy onboarding and manual scheduling actions must stay out of the real task toolbar",
  );
});
