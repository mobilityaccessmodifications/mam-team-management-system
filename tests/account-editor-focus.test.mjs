import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/components/account-management.tsx", "utf8");

test("account editor moves focus inside and restores the action trigger", () => {
  assert.match(source, /const editorPanelRef = useRef<HTMLDivElement>\(null\);/);
  assert.match(
    source,
    /querySelector<HTMLElement>\(\s*"\[data-account-editor-initial-focus\]",\s*\)[\s\S]*?focus\(\{ preventScroll: true \}\)/,
  );
  assert.match(
    source,
    /const returnTarget = editorReturnFocusRef\.current;[\s\S]*?returnTarget\.isConnected[\s\S]*?searchInputRef\.current[\s\S]*?focus\(\{ preventScroll: true \}\)/,
  );
  assert.match(
    source,
    /const returnFocusTarget = menu\?\.querySelector<HTMLElement>\("summary"\);[\s\S]*?openEditor\(account, action, returnFocusTarget\);/,
  );
  assert.match(source, /ref=\{editorPanelRef\}[\s\S]*?tabIndex=\{-1\}/);
  assert.match(source, /data-account-editor-initial-focus/);
});
