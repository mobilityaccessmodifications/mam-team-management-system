import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/components/account-management.module.css", "utf8");

test("mobile account password controls retain full touch targets", () => {
  const mobileOverride = source.indexOf(
    "/* Restore full touch targets after the compact shared button rhythm. */",
  );
  const mobileRules = source.slice(mobileOverride);

  assert.notEqual(mobileOverride, -1);
  assert.match(
    mobileRules,
    /\.fieldLabel button\s*\{[\s\S]*?min-height: 44px;[\s\S]*?touch-action: manipulation;/,
  );
  assert.match(
    mobileRules,
    /\.passwordInput\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) 44px;/,
  );
  assert.match(
    mobileRules,
    /\.passwordInput input,[\s\S]*?\.passwordInput button\s*\{[\s\S]*?height: 44px;/,
  );
  assert.match(
    mobileRules,
    /\.passwordInput button\s*\{[\s\S]*?width: 44px;[\s\S]*?touch-action: manipulation;/,
  );
});
