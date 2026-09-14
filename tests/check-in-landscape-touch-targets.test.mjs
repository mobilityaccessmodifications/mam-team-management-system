import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/components/check-in-register.module.css", "utf8");

test("short-screen landscape check-in controls retain full touch targets", () => {
  const compactActions = source.indexOf("/* Shared People Hub page rhythm. */");
  const landscapeOverride = source.indexOf("/* Preserve complete controls when a phone rotates");

  assert.notEqual(compactActions, -1);
  assert.ok(landscapeOverride > compactActions, "the landscape override must follow compact action styles");
  assert.match(
    source.slice(landscapeOverride),
    /@media \(max-width: 1000px\) and \(max-height: 500px\)[\s\S]*?\.secondaryAction,[\s\S]*?\.privateDetails summary\s*\{[\s\S]*?min-height: 44px;[\s\S]*?touch-action: manipulation;/,
  );
  assert.match(
    source.slice(landscapeOverride),
    /\.pagination\s*\{[\s\S]*?grid-template-columns: 44px minmax\(0, 1fr\) 44px;[\s\S]*?\.pagination button\s*\{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/,
  );
});
