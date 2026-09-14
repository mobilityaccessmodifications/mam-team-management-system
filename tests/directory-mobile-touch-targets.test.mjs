import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/components/employee-directory.module.css", "utf8");

test("mobile directory header actions override the compact desktop rhythm", () => {
  const sharedRhythm = source.indexOf("/* Shared People Hub page rhythm. */");
  const touchOverride = source.indexOf("/* Keep the compact phone header actions");

  assert.notEqual(sharedRhythm, -1);
  assert.ok(touchOverride > sharedRhythm, "the touch override must follow the compact 40px rule");
  assert.match(
    source.slice(touchOverride),
    /@media \(max-width: 640px\)[\s\S]*?\.headerActions > \.primaryAction,[\s\S]*?\.headerActions > \.secondaryAction\s*\{[\s\S]*?min-width: 44px;[\s\S]*?min-height: 44px;/,
  );
});
