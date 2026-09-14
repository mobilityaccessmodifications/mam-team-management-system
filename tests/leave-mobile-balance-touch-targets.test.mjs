import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/components/leave-demo.module.css", "utf8");

test("mobile administrator leave-balance actions override the compact button rhythm", () => {
  const compactButtons = source.lastIndexOf(".primaryButton, .secondaryButton, .approveButton, .declineButton");
  const touchOverride = source.indexOf("/* The compact desktop button rhythm is 40px");

  assert.notEqual(compactButtons, -1);
  assert.ok(touchOverride > compactButtons, "the balance touch override must follow the compact button rule");
  assert.match(
    source.slice(touchOverride),
    /@media \(max-width: 760px\), \(max-width: 1000px\) and \(max-height: 500px\)[\s\S]*?\.leaveBalanceActions \.secondaryButton,[\s\S]*?\.leaveBalanceEditor \.secondaryButton\s*\{\s*min-height: 44px;/,
  );
});
