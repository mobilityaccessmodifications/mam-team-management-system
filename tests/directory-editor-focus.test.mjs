import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/components/employee-directory.tsx", "utf8");

test("mobile directory editor falls back to the stable search control", () => {
  assert.match(source, /const directorySearchRef = useRef<HTMLInputElement>\(null\);/);
  assert.match(
    source,
    /useDialogFocus\(\s*Boolean\(activeEditor\)[\s\S]*?closeEditor,\s*directorySearchRef,\s*\);/,
  );
  assert.match(source, /<input\s*ref=\{directorySearchRef\}\s*value=\{query\}/);
});
