import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  "src/components/subscription-register.module.css",
  "utf8",
);

test("subscription employee-access disclosure has a complete touch target", () => {
  assert.match(
    source,
    /\.accessDetails summary\s*\{[\s\S]*?min-height: 44px;[\s\S]*?padding: 12px 0;[\s\S]*?touch-action: manipulation;/,
  );
});
