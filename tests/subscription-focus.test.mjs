import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/components/subscription-register.tsx", "utf8");

test("subscription dialogs retain explicit add and edit return targets", () => {
  assert.match(source, /const subscriptionDialogReturnFocusRef = useRef<HTMLElement \| null>\(null\)/);
  assert.match(
    source,
    /onClick=\{\(event\) => \{ subscriptionDialogReturnFocusRef\.current = event\.currentTarget; setEditTarget\(subscription\); \}\}/,
    "the row Edit trigger should remain available when pointer activation leaves document.activeElement on the page body",
  );
  assert.equal(
    source.match(/<SubscriptionModal[^>]*fallbackFocusRef=\{subscriptionDialogReturnFocusRef\}/g)?.length,
    2,
    "both add and edit subscription dialogs should receive their explicit return target",
  );
});
