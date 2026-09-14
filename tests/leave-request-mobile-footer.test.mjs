import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync("src/components/leave-demo.module.css", "utf8");

test("compact leave request dialogs keep their footer in normal flow", () => {
  const stickyFooter = styles.indexOf(".form footer {\n  position: sticky;");
  const compactFooter = styles.indexOf(".form footer {\n    position: static;");

  assert.notEqual(stickyFooter, -1);
  assert.ok(compactFooter > stickyFooter, "the compact footer override must follow the sticky desktop footer");
  assert.match(styles.slice(compactFooter), /^\.form footer \{\s*position: static;\s*bottom: auto;/);
});
