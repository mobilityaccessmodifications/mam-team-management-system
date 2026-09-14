import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/components/asset-register.module.css", "utf8");

test("mobile asset actions override the final compact desktop rhythm", () => {
  const sharedRhythm = source.indexOf("/* Shared People Hub page rhythm. */");
  const mobileTouchOverride = source.indexOf("/* Keep every phone action at the documented minimum");

  assert.notEqual(sharedRhythm, -1);
  assert.ok(mobileTouchOverride > sharedRhythm, "the touch override must follow the compact 40px rule");
  assert.match(
    source.slice(mobileTouchOverride),
    /@media \(max-width: 760px\)[\s\S]*?\.headerActions > a,[\s\S]*?\.headerActions > button,[\s\S]*?\.assetActionsCell\.rowActions button\s*\{\s*min-height: 44px;/,
  );
});
