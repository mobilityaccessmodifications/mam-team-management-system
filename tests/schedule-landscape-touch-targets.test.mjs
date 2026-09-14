import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/components/work-schedule-workflow.module.css", "utf8");

test("short-screen landscape schedule actions retain full touch targets", () => {
  const compactActions = source.indexOf(".iconButton,\n.modalHeader button");
  const landscapeOverride = source.indexOf("/* Short-screen phone layouts keep every schedule action");

  assert.notEqual(compactActions, -1);
  assert.ok(landscapeOverride > compactActions, "the landscape override must follow compact action styles");
  assert.match(
    source.slice(landscapeOverride),
    /@media \(max-width: 1000px\) and \(max-height: 500px\)[\s\S]*?\.iconButton,[\s\S]*?\.modalHeader button\s*\{[\s\S]*?width: 44px;[\s\S]*?height: 44px;[\s\S]*?\.reviewActions button,[\s\S]*?\.loadError button\s*\{\s*min-height: 44px;/,
  );
});
