import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const registerSource = readFileSync("src/components/subscription-register.module.css", "utf8");
const credentialSource = readFileSync("src/components/subscription-credential-vault.module.css", "utf8");

test("short-screen landscape subscription controls retain full touch targets", () => {
  const registerOverride = registerSource.indexOf("/* Keep the spreadsheet and disclosure controls touch-safe");
  const credentialOverride = credentialSource.indexOf("/* Credential editors retain complete controls");

  assert.ok(registerOverride > registerSource.indexOf("/* Shared People Hub page rhythm. */"));
  assert.ok(credentialOverride > credentialSource.indexOf("/* Shared People Hub page rhythm. */"));
  assert.match(
    registerSource.slice(registerOverride),
    /@media \(max-width: 1000px\) and \(max-height: 500px\)[\s\S]*?\.headerActionGroup > button,[\s\S]*?\.searchField input,[\s\S]*?\.sheetFilterMenu button,[\s\S]*?\.subscriptionActions button,[\s\S]*?\.accessDetails summary\s*\{[\s\S]*?min-height: 44px;[\s\S]*?\.sheetHeaderCell\s*\{[\s\S]*?padding: 2px 6px;[\s\S]*?\.sheetHeaderButton\s*\{[\s\S]*?width: 44px;[\s\S]*?min-width: 44px;[\s\S]*?min-height: 44px;/,
  );
  assert.match(
    credentialSource.slice(credentialOverride),
    /@media \(max-width: 1000px\) and \(max-height: 500px\)[\s\S]*?\.primaryAction,[\s\S]*?\.secondaryAction,[\s\S]*?\.dangerAction,[\s\S]*?\.modal input:not\(\[type="checkbox"\]\)\s*\{[\s\S]*?min-height: 44px;/,
  );
});
