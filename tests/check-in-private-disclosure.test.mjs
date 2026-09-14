import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync("src/components/check-in-register.module.css", "utf8");

test("closed check-in contact disclosure hides private details", () => {
  const visiblePrivateDetails = styles.indexOf(".privateDetails > div { align-items: stretch;");
  const closedOverride = styles.indexOf(".privateDetails:not([open]) > :not(summary) { display: none; }");

  assert.notEqual(visiblePrivateDetails, -1);
  assert.ok(closedOverride > visiblePrivateDetails, "the closed-state override must follow the flex layout rule");
});
