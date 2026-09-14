import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/components/asset-register.module.css", "utf8");

test("short-screen landscape asset controls retain full touch targets", () => {
  const compactActions = source.indexOf("/* Shared People Hub page rhythm. */");
  const landscapeOverride = source.indexOf("/* Preserve touch targets in short-screen landscape");

  assert.notEqual(compactActions, -1);
  assert.ok(landscapeOverride > compactActions, "the landscape override must follow compact action styles");
  assert.match(
    source.slice(landscapeOverride),
    /@media \(max-width: 1000px\) and \(max-height: 500px\)[\s\S]*?\.headerActions > a,[\s\S]*?\.searchField input,[\s\S]*?\.sheetFilterMenu button,[\s\S]*?\.assetActionsCell\.rowActions button\s*\{[\s\S]*?min-height: 44px;/,
  );
  assert.match(
    source.slice(landscapeOverride),
    /\.sheetHeaderCell\s*\{[\s\S]*?padding: 2px 6px;[\s\S]*?\.sheetHeaderTools\s*\{[\s\S]*?gap: 0;[\s\S]*?\.sheetHeaderButton\s*\{[\s\S]*?width: 44px;[\s\S]*?min-width: 44px;[\s\S]*?min-height: 44px;/,
  );
});
