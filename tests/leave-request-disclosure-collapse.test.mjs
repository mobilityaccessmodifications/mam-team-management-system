import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync("src/components/leave-demo.module.css", "utf8");

test("closed leave request disclosures hide their form controls", () => {
  assert.match(
    styles,
    /\.timeRange:not\(\[open\]\) > :not\(summary\),\s*\.requestExtras:not\(\[open\]\) > :not\(summary\) \{ display: none; \}/,
  );
});
