import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/components/leave-demo.module.css", "utf8");

test("short-screen landscape navigation and leave filters retain touch targets", () => {
  const compactNavigation = source.indexOf(".navItem {\n    flex: 1 0 auto;\n    min-height: 42px;");
  const landscapeOverride = source.indexOf("/* Short-screen phones use the horizontal shell");

  assert.notEqual(compactNavigation, -1);
  assert.ok(landscapeOverride > compactNavigation, "the landscape override must follow compact shell styles");
  assert.match(
    source.slice(landscapeOverride),
    /@media \(max-width: 1000px\) and \(max-height: 500px\)[\s\S]*?\.navItem,[\s\S]*?\.filterTabs button\s*\{\s*min-height: 44px;[\s\S]*?touch-action: manipulation;/,
  );
});
