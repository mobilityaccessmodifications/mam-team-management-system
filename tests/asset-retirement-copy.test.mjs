import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const componentSource = readFileSync("src/components/asset-register.tsx", "utf8");
const actionSource = readFileSync("src/app/assets/actions.ts", "utf8");

test("asset retirement copy describes the retained-history operation", () => {
  assert.match(componentSource, /<h2 id="retire-device-title">Retire device\?<\/h2>/);
  assert.match(componentSource, /Retire duplicate or incorrect records to hide them from the active register while preserving their history\./);
  assert.match(componentSource, /saving \? "Retiring…" : "Retire incorrect entry"/);
  assert.match(componentSource, /<Trash2 size=\{15\} \/><span>Retire<\/span>/);
  assert.match(componentSource, /was retired and removed from the active register\./);
  assert.match(actionSource, /The device could not be retired\. Refresh and try again\./);
  assert.doesNotMatch(componentSource, /Remove device\?|Remove incorrect entry|>Remove<\/span>/);
});
