import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/components/organisation-tree.module.css", "utf8");

test("mobile organisation header actions override the compact desktop rhythm", () => {
  const sharedRhythm = source.indexOf("/* Shared People Hub page rhythm. */");
  const touchOverride = source.indexOf("/* Preserve the 44px phone target");

  assert.notEqual(sharedRhythm, -1);
  assert.ok(touchOverride > sharedRhythm, "the touch override must follow the compact 40px rule");
  assert.match(
    source.slice(touchOverride),
    /@media \(max-width: 640px\)[\s\S]*?\.headerActions > button\s*\{\s*min-height: 44px;[\s\S]*?touch-action: manipulation;/,
  );
});
