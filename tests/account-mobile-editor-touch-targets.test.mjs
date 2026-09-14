import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/components/account-management.module.css", "utf8");

test("mobile account editor actions override the compact button rhythm", () => {
  const compactRhythm = source.indexOf("/* Shared People Hub page rhythm. */");
  const mobileOverride = source.indexOf(
    "/* Restore full touch targets after the compact shared button rhythm. */",
  );

  assert.notEqual(compactRhythm, -1);
  assert.ok(
    mobileOverride > compactRhythm,
    "the mobile target override must follow the compact shared rhythm",
  );
  assert.match(
    source.slice(mobileOverride),
    /@media \(max-width: 720px\)[\s\S]*?\.primaryButton,[\s\S]*?\.secondaryButton,[\s\S]*?\.dangerButton\s*\{[\s\S]*?min-height: 44px;[\s\S]*?touch-action: manipulation;/,
  );
});
