import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/components/analytics-api-management.module.css", "utf8");

test("desktop Analytics API disclosure summary has a complete target", () => {
  const sharedRhythm = source.indexOf("/* Shared People Hub page rhythm. */");
  const globalSummaryRule = source.indexOf(".guide summary { display: flex;", sharedRhythm);

  assert.ok(globalSummaryRule > sharedRhythm);
  assert.match(
    source.slice(globalSummaryRule),
    /^\.guide summary \{[^}]*min-height: 44px;[^}]*align-items: center;[^}]*touch-action: manipulation;/,
  );
});
