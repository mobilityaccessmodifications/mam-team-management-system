import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(import.meta.url);
const ts = require("typescript");
const loaded = { exports: {} };
new Function("module", "exports", ts.transpileModule(readFileSync("src/lib/subscription-types.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(loaded, loaded.exports);
const { subscriptionCountLabel, subscriptionCompanyLabel } = loaded.exports;
const { matchesSubscriptionCategory } = loaded.exports;
test("pricing and company filters combine and include shared subscriptions", () => {
  const records = [
    { pricingModel: "free", company: "mam" },
    { pricingModel: "paid", company: "equipsy" },
    { pricingModel: "paid", company: "both" },
    { pricingModel: "paid", company: null },
  ];
  const select = (pricing, company) => records.filter((row) => matchesSubscriptionCategory(row, pricing, company));
  assert.deepEqual(select("", ""), records);
  assert.deepEqual(select("paid", "mam"), [records[2]]);
  assert.deepEqual(select("paid", "equipsy"), [records[1], records[2]]);
  assert.deepEqual(select("", "both"), [records[2]]);
  assert.deepEqual(select("", "unset"), [records[3]]);
  assert.deepEqual(select("free", "equipsy"), []);
  assert.equal(subscriptionCountLabel(select("paid", "equipsy"), records.length), "2 of 4 subscriptions (0 Free, 2 Paid)");
});
test("count is an accessible disclosure sharing existing filters", () => {
  const source = readFileSync("src/components/subscription-register.tsx", "utf8");
  assert.match(source, /aria-expanded=\{showFilters\} aria-controls=\{filterPanelId\}/);
  assert.match(source, /aria-label="Subscription filters" hidden=\{!showFilters\}/);
  assert.match(source, /setSubscriptionFilters\(emptySubscriptionFilters\)/);
  assert.match(source, /filterButtonRef.current\?\.focus\(\)/);
  assert.match(source, /const restoreColumnFocus = activeSubscriptionFilter === key/);
  assert.match(source, /if \(!restoreColumnFocus\) return;/);
  for (const key of ["pricing", "company", "billing", "status", "responsible", "nextReview"]) {
    assert.ok(source.includes(`{ key: "${key}", label:`));
  }
});
test("subscription totals distinguish pricing model, not zero cost", () => {
  assert.equal(subscriptionCountLabel([{ pricingModel: "free" }, { pricingModel: "paid", amountCents: 0 }]), "2 subscriptions (1 Free, 1 Paid)");
  assert.equal(subscriptionCountLabel([]), "0 subscriptions (0 Free, 0 Paid)");
  assert.equal(subscriptionCountLabel([{ pricingModel: "paid" }], 75), "1 of 75 subscriptions (0 Free, 1 Paid)");
  assert.equal(subscriptionCountLabel([{ pricingModel: "free" }]), "1 subscription (1 Free, 0 Paid)");
});
test("company flags preserve unclassified legacy subscriptions", () => {
  assert.deepEqual(["mam", "equipsy", "both", null].map(subscriptionCompanyLabel), ["MAM", "Equipsy", "Both", "Not set"]);
});
test("subscription actions use company-aware RPCs and validate enum", () => {
  const source = readFileSync("src/app/subscriptions/actions.ts", "utf8");
  assert.match(source, /SUBSCRIPTION_COMPANIES.includes\(company as SubscriptionCompany\)/);
  assert.match(source, /p_company_scope: company/);
  assert.match(source, /rpc\("create_subscription_v4"/);
  assert.match(source, /rpc\("update_subscription_v4"/);
});
test("management UI uses a separate capability and makes preview read-only", () => {
  const source = readFileSync("src/components/leave-demo.tsx", "utf8");
  assert.match(source, /readOnly=\{!canManageSubscriptions \|\| isPreviewingEmployeeAccess\}/);
  assert.match(readFileSync("src/app/page.tsx", "utf8"), /rpc\("can_manage_subscriptions"\)/);
});
