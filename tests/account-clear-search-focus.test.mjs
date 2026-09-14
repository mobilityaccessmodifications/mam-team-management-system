import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/components/account-management.tsx", "utf8");

test("clearing an empty account search restores focus to the search field", () => {
  assert.match(source, /const searchInputRef = useRef<HTMLInputElement>\(null\);/);
  assert.match(
    source,
    /function clearSearch\(\) \{\s*updateQuery\(""\);\s*searchInputRef\.current\?\.focus\(\{ preventScroll: true \}\);\s*\}/,
  );
  assert.match(source, /<button onClick=\{clearSearch\} type="button">\s*Clear search/);
});
