import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/components/organisation-tree.module.css", "utf8");

test("organisation work email has a complete touch target", () => {
  assert.match(
    source,
    /\.workEmail\s*\{[\s\S]*?min-height: 44px;[\s\S]*?touch-action: manipulation;/,
  );
});
