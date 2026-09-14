import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/components/account-management.module.css", "utf8");

test("short-screen landscape account controls retain full touch targets", () => {
  const compactActions = source.indexOf("/* Shared People Hub page rhythm. */");
  const landscapeOverride = source.indexOf("/* Keep account controls usable when compact phones rotate");

  assert.notEqual(compactActions, -1);
  assert.ok(landscapeOverride > compactActions, "the landscape override must follow compact action styles");
  assert.match(
    source.slice(landscapeOverride),
    /@media \(max-width: 1000px\) and \(max-height: 500px\)[\s\S]*?\.primaryButton,[\s\S]*?\.fieldLabel button,[\s\S]*?\.searchField input,[\s\S]*?\.sortField select\s*\{[\s\S]*?min-height: 44px;/,
  );
  assert.match(
    source.slice(landscapeOverride),
    /\.pageControls button\s*\{[\s\S]*?min-width: 44px;[\s\S]*?min-height: 44px;[\s\S]*?\.passwordInput\s*\{[\s\S]*?height: 46px;[\s\S]*?grid-template-columns: minmax\(0, 1fr\) 44px;[\s\S]*?\.passwordInput input,[\s\S]*?\.passwordInput button\s*\{[\s\S]*?height: 44px;[\s\S]*?\.passwordInput button\s*\{[\s\S]*?width: 44px;/,
  );
});
