import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/components/organisation-tree.tsx", "utf8");

test("organisation filter closes on Escape and restores trigger focus", () => {
  assert.match(source, /const filterButtonRef = useRef<HTMLButtonElement>\(null\);/);
  assert.match(
    source,
    /onKeyDown=\{\(event\) => \{\s*if \(event\.key !== "Escape" \|\| !filterOpen\) return;\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*setFilterOpen\(false\);\s*filterButtonRef\.current\?\.focus\(\);/,
  );
  assert.match(source, /aria-label="Filter organisation"[\s\S]*?ref=\{filterButtonRef\}/);
});
