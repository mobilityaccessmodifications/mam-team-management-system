import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/components/account-management.module.css", "utf8");

test("account empty-state clear action has a complete touch target", () => {
  assert.match(
    source,
    /\.emptyState button\s*\{[\s\S]*?min-height: 44px;[\s\S]*?padding: 10px 12px;[\s\S]*?touch-action: manipulation;/,
  );
});
