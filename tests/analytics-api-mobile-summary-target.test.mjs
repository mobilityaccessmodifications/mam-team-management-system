import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/components/analytics-api-management.module.css", "utf8");

test("mobile Analytics API disclosure summary has a full touch target", () => {
  const mobileTouchRules = source.indexOf("/* Keep the expanded phone guide action");

  assert.notEqual(mobileTouchRules, -1);
  assert.match(
    source.slice(mobileTouchRules),
    /@media \(max-width: 760px\)[\s\S]*?\.guide summary\s*\{[\s\S]*?display: flex;[\s\S]*?min-height: 44px;[\s\S]*?touch-action: manipulation;/,
  );
});
