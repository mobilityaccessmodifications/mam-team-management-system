import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/components/organisation-tree.module.css", "utf8");

test("short-screen landscape organisation controls retain reachable touch targets", () => {
  const compactActions = source.indexOf("/* Shared People Hub page rhythm. */");
  const landscapeOverride = source.indexOf("/* Keep short-screen landscape tools reachable");

  assert.notEqual(compactActions, -1);
  assert.ok(landscapeOverride > compactActions, "the landscape override must follow compact action styles");
  assert.match(
    source.slice(landscapeOverride),
    /@media \(max-width: 1000px\) and \(max-height: 500px\)[\s\S]*?\.headerActions > button,[\s\S]*?\.filterOption,[\s\S]*?\.inspectorActions \.primaryAction,[\s\S]*?\.inspectorActions \.secondaryAction\s*\{[\s\S]*?min-height: 44px;[\s\S]*?touch-action: manipulation;/,
  );
  assert.match(
    source.slice(landscapeOverride),
    /\.filterCard\s*\{[\s\S]*?top: auto;[\s\S]*?bottom: calc\(100% \+ 8px\);[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
  );
});
