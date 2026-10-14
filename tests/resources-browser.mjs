// Synthetic component regressions in a real browser. No Next server, .env,
// network or provider is needed. Run through the approved browser adapter:
// const { installResourcesFixture, runResourcesRegressions } = await import("/absolute/worktree/tests/resources-browser.mjs");
// await installResourcesFixture(page); await runResourcesRegressions(page);
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

export async function installResourcesFixture(page) {
  const root = new URL("../", import.meta.url);
  const modules = {};
  for (const [id, file] of Object.entries({
    react: "react/cjs/react.production.js",
    "react/jsx-runtime": "react/cjs/react-jsx-runtime.production.js",
    "react-dom": "react-dom/cjs/react-dom.production.js",
    "react-dom/client": "react-dom/cjs/react-dom-client.production.js",
    scheduler: "scheduler/cjs/scheduler.production.js",
  })) modules[id] = readFileSync(new URL(`node_modules/${file}`, root), "utf8");
  for (const path of [
    "components/subscription-register.tsx", "components/subscription-credential-vault.tsx",
    "components/subscription-delegation-dialog.tsx",
    "components/employee-picker.tsx", "components/ui/use-dialog-focus.ts",
    "components/ui/modal-backdrop.tsx", "components/ui/mobile-register-tools.tsx",
    "lib/subscription-types.ts", "lib/subscription-bulk.ts",
    "lib/subscription-review-date.ts", "lib/subscription-editor-state.ts",
  ]) {
    const id = `@/${path.replace(/\.tsx?$/, "")}`;
    modules[id] = ts.transpileModule(readFileSync(new URL(`src/${path}`, root), "utf8"), {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    if (path === "components/subscription-register.tsx") {
      modules[id] += "\nexports.TestSubscriptionModal = SubscriptionModal; exports.TestSubscriptionMemberPicker = SubscriptionMemberPicker;";
    }
  }
  await page.goto("about:blank");
  await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.evaluate((sources) => {
    const cache = {};
    const results = { saves: [], reviews: 0, closes: 0, reads: 0, credentialSaves: 0, submits: 0 };
    const actions = new Proxy({}, { get: (_, name) => {
      if (name === "updateSubscription" || name === "createSubscription") return async (input) => {
        results.saves.push(input);
        return { ...subscription, ...input };
      };
      if (name === "readSubscriptionCredential") return async () => { results.reads++; return null; };
      if (name === "saveSubscriptionCredential") return async () => { results.credentialSaves++; };
      return () => { throw new Error(`Unexpected action: ${String(name)}`); };
    } });
    function require(id) {
      if (id.endsWith(".css")) return { default: new Proxy({}, { get: (_, key) => String(key) }) };
      if (id === "next/navigation") return { useRouter: () => ({ push: (url) => { results.navigation = url; } }) };
      if (id === "lucide-react") return new Proxy({}, { get: () => () => null });
      if (id.startsWith("@/app/")) return actions;
      if (cache[id]) return cache[id].exports;
      if (!sources[id]) throw new Error(`Unexpected module: ${id}`);
      const loaded = { exports: {} };
      cache[id] = loaded;
      new Function("require", "module", "exports", sources[id])(require, loaded, loaded.exports);
      return loaded.exports;
    }
    // Only the synthetic page gets these guards. Do not read or clear any real storage.
    window.fetch = () => { throw new Error("Network is forbidden in resource regressions"); };
    Storage.prototype.setItem = () => { throw new Error("Credential persistence is forbidden"); };
    // Control visibility for deterministic timer tests even if another desktop
    // task takes the foreground. The hidden transition is exercised explicitly.
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const React = require("react");
    const { flushSync } = require("react-dom");
    const { createRoot } = require("react-dom/client");
    const { useDialogFocus } = require("@/components/ui/use-dialog-focus");
    const { EmployeePicker } = require("@/components/employee-picker");
    const { TestSubscriptionModal, TestSubscriptionMemberPicker } = require("@/components/subscription-register");
    const { SubscriptionCredentialEditor } = require("@/components/subscription-credential-vault");
    const h = React.createElement;
    const people = [
      { personId: "person-a", fullName: "Synthetic Alpha", positionTitle: "Tester", teamName: "QA", company: "mam" },
      { personId: "person-b", fullName: "Synthetic Beta", positionTitle: "Tester", teamName: "QA", company: "mam" },
    ];
    const subscription = {
      id: "subscription-a", subscriptionCode: "SUB-0001", serviceName: "Synthetic service", planName: "Team",
      company: "mam", status: "active", pricingModel: "paid", billingCycle: "monthly", amountCents: 1000,
      currency: "AUD", renewalDate: null, seatCount: 2, creditCardUsed: false, creditCardHolder: null,
      billingDate: "2026-09-01", nextBillingOn: "2026-10-01", lastReviewedOn: null, nextReviewOn: "2026-09-22",
      responsible: people[0], memberPersonIds: ["person-a"], memberNames: ["Synthetic Alpha"], version: 1,
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let now = 0;
    let nextTimer = -1;
    const timers = new Map();
    const realSetTimeout = window.setTimeout.bind(window);
    const realClearTimeout = window.clearTimeout.bind(window);
    window.setTimeout = (fn, ms, ...args) => {
      if (ms !== 60_000) return realSetTimeout(fn, ms, ...args);
      const id = nextTimer--;
      timers.set(id, { at: now + ms, fn });
      return id;
    };
    window.clearTimeout = (id) => { timers.delete(id); realClearTimeout(id); };
    function FocusDialog({ child = false, onClose, children }) {
      const ref = React.useRef(null);
      useDialogFocus(true, ref, null, onClose);
      return h("section", { role: "dialog", ref, id: child ? "child" : "parent" }, children);
    }
    function FocusFixture() {
      const [open, setOpen] = React.useState(false);
      return h(FocusDialog, { onClose: () => { results.closes++; } },
        h("button", { id: "first" }, "First"),
        h("details", { id: "details" }, h("summary", { id: "summary" }, "Disclosure"), h("input", { id: "inside" })),
        h("input", { hidden: true, id: "hidden" }),
        h("button", { style: { visibility: "hidden" } }, "Invisible"),
        h("fieldset", { disabled: true }, h("input", { id: "disabled-descendant" })),
        h("div", { inert: true }, h("button", null, "Inert")),
        h("button", { id: "last", onClick: () => setOpen(true) }, "Open nested"),
        open ? h(FocusDialog, { child: true, onClose: () => setOpen(false) }, h("button", { id: "child-first" }, "Child first"), h("button", { id: "child-last" }, "Child last")) : null);
    }
    function MemberFixture() {
      const [active, setActive] = React.useState(people);
      const [members, setMembers] = React.useState(["person-a"]);
      return h("div", null,
        h("button", { id: "archive", onClick: () => setActive([people[0]]) }, "Archive synthetic Beta"),
        h(TestSubscriptionMemberPicker, { people: active, selectedIds: members, onChange: setMembers }));
    }
    window.__resources = {
      results,
      mount(kind, options = {}) {
        flushSync(() => root.render(null));
        Object.assign(results, { saves: [], reviews: 0, closes: 0, reads: 0, credentialSaves: 0, submits: 0 });
        let element;
        const close = () => { results.closes++; };
        if (kind === "focus") element = h(FocusFixture);
        if (kind === "members") element = h(MemberFixture);
        if (kind === "picker") element = h("form", { onSubmit: (event) => { event.preventDefault(); results.submits++; } },
          h(EmployeePicker, { assignees: people, defaultValue: "person-a" }), h("button", { type: "submit" }, "Submit"));
        if (kind === "subscription") element = h(TestSubscriptionModal, {
          subscription: { ...subscription, ...options.subscription }, people, onClose: close,
          onUpdated: close,
          onReview: async () => {
            results.reviews++;
            if (options.reviewFailure) throw new Error("Synthetic review failure");
            if (options.pendingReview) await new Promise((resolve) => { window.__resources.finishReview = resolve; });
          },
        });
        if (kind === "credential") element = h(SubscriptionCredentialEditor, {
          subscriptionId: "synthetic-credential", serviceName: "Synthetic vault", credentialsSaved: false, onClose: close,
        });
        flushSync(() => root.render(element));
      },
      advance(ms) {
        now += ms;
        for (const [id, timer] of timers) if (timer.at <= now) {
          timers.delete(id);
          flushSync(() => timer.fn());
        }
      },
      setVisibility(value) {
        Object.defineProperty(document, "visibilityState", { configurable: true, value });
        flushSync(() => document.dispatchEvent(new Event("visibilitychange")));
      },
      unmount() { flushSync(() => root.render(null)); },
      timerCount: () => timers.size,
    };
  }, modules);
}

export async function runResourcesRegressions(page) {
  const passed = [];
  const mount = (kind, options) => page.evaluate(({ kind, options }) => window.__resources.mount(kind, options), { kind, options });
  const state = () => page.evaluate(() => window.__resources.results);
  const active = () => page.evaluate(() => document.activeElement?.id);
  const text = () => page.evaluate(() => document.body.textContent);

  await mount("focus");
  await page.focus("#summary");
  await page.press("#summary", "Tab");
  assert.equal(await active(), "last", "closed summary proceeds to the next visible enabled control");
  await page.press("#last", "Shift+Tab");
  assert.equal(await active(), "summary");
  await page.press("#summary", "Enter");
  await page.press("#summary", "Tab");
  assert.equal(await active(), "inside", "expanded summary reaches its revealed field");
  await page.press("#inside", "Shift+Tab");
  assert.equal(await active(), "summary");
  await page.focus("#first");
  await page.press("#first", "Shift+Tab");
  assert.equal(await active(), "last", "wrap skips disabled fieldsets, inert and hidden descendants");
  await page.click("#last");
  await page.waitForSelector("#child-first");
  await page.press("#child-first", "Shift+Tab");
  assert.equal(await active(), "child-last");
  await page.press("#child-last", "Escape");
  assert.equal(await active(), "last", "nested close restores its trigger");
  assert.equal((await state()).closes, 0, "nested Escape must not close parent");
  passed.push("U01: native summary selector, closed/open traversal, hidden/disabled/inert controls, nested focus and return");

  await mount("picker");
  await page.fill('[role="combobox"]', "no-synthetic-result");
  await page.press('[role="combobox"]', "Enter");
  assert.equal((await state()).submits, 0, "no-result Enter cannot submit stale selected ID");
  assert.match(await page.evaluate(() => document.querySelector('[role="status"]').textContent), /No employees match/);
  await page.press('[role="combobox"]', "Escape");
  assert.equal(await page.evaluate(() => document.querySelector('[role="combobox"]').value), "Synthetic Alpha");
  await page.fill('[role="combobox"]', "Beta");
  await page.press('[role="combobox"]', "Enter");
  assert.equal(await page.evaluate(() => document.querySelector('input[type="hidden"]').value), "person-b");
  assert.equal((await state()).submits, 0);
  passed.push("U02: no-result Enter blocked, live feedback, Escape restoration and explicit new selection");

  await mount("members");
  await page.click('input[type="checkbox"] >> nth=1');
  await page.click("#archive");
  assert.match(await text(), /Inactive or unavailable member 1/);
  assert.doesNotMatch(await page.evaluate(() => document.querySelector("fieldset").textContent), /Synthetic Beta/);
  await page.fill('input[type="search"]', "no-result");
  await page.click('[aria-label="Remove inactive or unavailable member 1"]');
  assert.doesNotMatch(await text(), /Inactive or unavailable member/);
  await page.fill('input[type="search"]', "Beta");
  assert.equal(await page.evaluate(() => document.querySelectorAll('input[type="checkbox"]').length), 0);
  await mount("subscription", { subscription: { memberPersonIds: ["person-a", "archived-person"], memberNames: ["Synthetic Alpha", "Archived synthetic"] } });
  await page.fill('[name="serviceName"]', "Changed synthetic service");
  await page.click('button[type="submit"]');
  assert.equal((await state()).saves.length, 0);
  await page.click("summary");
  await page.click('[aria-label="Remove inactive or unavailable member 1"]');
  await page.click('button[type="submit"]');
  assert.deepEqual((await state()).saves[0].memberPersonIds, ["person-a"]);
  assert.equal((await state()).saves[0].serviceName, "Changed synthetic service");
  passed.push("A03: add then archive then remove, search-independent removals, no inactive re-add, explicit save succeeds");

  for (const [selector, value] of [["amount", "12.00"], ["seatCount", "3"], ["serviceName", "Edited service"]]) {
    await mount("subscription");
    await page.fill(`[name="${selector}"]`, value);
    await page.click('button:text-is("Mark review complete")');
    assert.equal((await state()).reviews, 0);
    assert.equal((await state()).closes, 0);
    assert.equal((await state()).saves.length, 0, "review cannot automatically save edits");
    assert.match(await text(), /Save your changes before marking/);
    assert.equal(await page.evaluate((selector) => document.querySelector(selector).value, `[name="${selector}"]`), value);
  }
  await mount("subscription");
  await page.fill('[role="combobox"]', "Beta");
  await page.press('[role="combobox"]', "Enter");
  await page.click('button:text-is("Mark review complete")');
  assert.equal((await state()).reviews, 0, "changed hidden responsible ID is dirty");
  await mount("subscription");
  await page.click("summary");
  await page.click('input[type="checkbox"] >> nth=1');
  await page.click('button:text-is("Mark review complete")');
  assert.equal((await state()).reviews, 0, "member state is dirty");
  await mount("subscription", { reviewFailure: true });
  await page.click('button:text-is("Mark review complete")');
  assert.equal((await state()).closes, 0);
  assert.match(await text(), /Synthetic review failure/);
  await mount("subscription", { pendingReview: true });
  await page.click('button:text-is("Mark review complete")');
  assert.equal(await page.evaluate(() => document.querySelector('[name="amount"]').matches(":disabled")), true, "pending review cannot accept edits that would be discarded");
  await page.evaluate(() => window.__resources.finishReview());
  await page.waitForFunction(() => window.__resources.results.closes === 1);
  passed.push("U06: amount/seats/name/owner/members stay intact, no implicit save or review, errors stay open, pending fields disabled");

  await mount("credential");
  for (let cycle = 0; cycle < 2; cycle++) {
    if (cycle) await page.click('button:text-is("Enter credentials again")');
    await page.fill('input[autocomplete="new-password"]', `synthetic-secret-${cycle}`);
    await page.click('[aria-label="Show password"]');
    await page.evaluate(() => window.__resources.advance(59_999));
    assert.equal(await page.evaluate(() => document.querySelector('input[autocomplete="new-password"]').type), "text");
    await page.evaluate(() => window.__resources.advance(1));
    assert.match(await text(), /Unsaved credentials cleared/);
    assert.equal(await page.evaluate(() => document.querySelector('input[autocomplete="new-password"]')), null);
  }
  await page.click('button:text-is("Enter credentials again")');
  assert.equal(await page.evaluate(() => document.querySelector('input[autocomplete="new-password"]').type), "password");
  assert.equal(await page.evaluate(() => document.querySelector('input[autocomplete="new-password"]').value), "");
  await page.fill('input[autocomplete="new-password"]', "synthetic-hidden-tab-secret");
  await page.evaluate(() => window.__resources.setVisibility("hidden"));
  assert.match(await text(), /Unsaved credentials cleared/);
  await page.evaluate(() => window.__resources.setVisibility("visible"));
  assert.equal((await state()).reads, 0, "new credential restart must not fetch saved secrets");
  assert.equal((await state()).credentialSaves, 0, "timer must not persist secrets");
  await page.evaluate(() => window.__resources.unmount());
  assert.equal(await page.evaluate(() => window.__resources.timerCount()), 0);
  passed.push("U04: repeated 60-second expiry clears new secrets and password visibility, hidden tabs clear, no reads/saves/storage");
  return passed;
}
