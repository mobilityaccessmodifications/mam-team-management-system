import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/components/analytics-api-management.module.css", "utf8");

test("mobile Analytics API guide restores the Copy example touch target", () => {
  const compactGuideAction = source.indexOf(".copyGuide { justify-self: start; min-height: 38px;");
  const touchOverride = source.indexOf("/* Keep the expanded phone guide action");

  assert.notEqual(compactGuideAction, -1);
  assert.ok(touchOverride > compactGuideAction, "the phone override must follow the compact guide action");
  assert.match(
    source.slice(touchOverride),
    /@media \(max-width: 760px\)[\s\S]*?\.copyGuide\s*\{\s*min-height: 44px;[\s\S]*?touch-action: manipulation;/,
  );
});
