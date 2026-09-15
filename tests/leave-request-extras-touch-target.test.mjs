import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync("src/components/leave-demo.module.css", "utf8");

test("leave request extras disclosure has a complete touch target", () => {
  assert.match(
    styles,
    /\.requestExtras summary \{[^}]*min-height: 44px;[^}]*padding-block: 10px;[^}]*touch-action: manipulation;[^}]*\}/,
  );
});

test("attachment deletion and confirmation controls retain full touch targets", () => {
  for (const selector of [
    ".attachmentDeleteButton",
    ".attachmentDeleteKeepButton",
    ".attachmentDeleteConfirmButton",
  ]) {
    assert.match(
      styles,
      new RegExp(`${selector.replace(".", "\\.")}[^}]*\\{[^}]*min-height: 44px;`),
    );
  }
  assert.match(styles, /\.attachmentItemActions \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/);
});
