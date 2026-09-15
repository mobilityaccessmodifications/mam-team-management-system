import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const loaded = { exports: {} };
const compiled = ts.transpileModule(readFileSync("src/lib/subscription-types.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function("module", "exports", compiled)(loaded, loaded.exports);

const { compareSubscriptionMonthlyCost } = loaded.exports;
const monthly = (amountCents) => ({ pricingModel: "paid", billingCycle: "monthly", amountCents });
const annual = (amountCents) => ({ pricingModel: "paid", billingCycle: "annual", amountCents });
const manual = { pricingModel: "paid", billingCycle: "other", amountCents: 5000 };
const free = { pricingModel: "free", billingCycle: null, amountCents: null };

test("monthly cost descending keeps paid values high-to-low and Free last", () => {
  const sorted = [free, monthly(1000), annual(120000), monthly(5000), manual]
    .sort((first, second) => compareSubscriptionMonthlyCost(first, second, "descending"));

  assert.deepEqual(sorted, [annual(120000), monthly(5000), monthly(1000), manual, free]);
});

test("monthly cost ascending also keeps Free last", () => {
  const sorted = [free, monthly(5000), monthly(1000)]
    .sort((first, second) => compareSubscriptionMonthlyCost(first, second, "ascending"));

  assert.deepEqual(sorted, [monthly(1000), monthly(5000), free]);
});

test("subscription form uses company-neutral card labels and a free-text cardholder", () => {
  const source = readFileSync("src/components/subscription-register.tsx", "utf8");
  assert.match(source, />Credit card used </);
  assert.match(source, />Cardholder \/ card name </);
  assert.match(source, /name="creditCardHolder"[^>]+maxLength=\{160\}/);
  assert.doesNotMatch(source, /MAM credit card used|MAM card:/);
});
