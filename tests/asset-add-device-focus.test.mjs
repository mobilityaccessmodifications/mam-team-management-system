import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/components/asset-register.tsx", "utf8");

test("Add device restores focus to its stable header action", () => {
  assert.match(
    source,
    /function AddDeviceModal\(\{[\s\S]*?fallbackFocusRef,[\s\S]*?fallbackFocusRef: RefObject<HTMLElement \| null> \| null;/,
  );
  assert.match(
    source,
    /useDialogFocus\(\s*true,\s*dialogRef,\s*assigneeRef,\s*closeWhenReady,\s*fallbackFocusRef,\s*\);/,
  );
  assert.match(
    source,
    /<AddDeviceModal assignees=\{assignees\} fallbackFocusRef=\{addDeviceButtonRef\}/,
  );
});
