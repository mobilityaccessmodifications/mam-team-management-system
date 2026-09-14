import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/components/analytics-api-management.module.css", "utf8");

test("short-screen landscape Analytics API guide retains full touch targets", () => {
  const compactGuideAction = source.indexOf(".copyGuide { justify-self: start; min-height: 38px;");
  const landscapeOverride = source.indexOf("/* Short landscape screens need the same complete guide controls");

  assert.ok(landscapeOverride > compactGuideAction, "the landscape override must follow the compact guide action");
  assert.match(
    source.slice(landscapeOverride),
    /@media \(max-width: 1000px\) and \(max-height: 500px\)[\s\S]*?\.copyGuide\s*\{[\s\S]*?min-height: 44px;[\s\S]*?\.guide summary\s*\{[\s\S]*?display: flex;[\s\S]*?min-height: 44px;[\s\S]*?touch-action: manipulation;/,
  );
});
