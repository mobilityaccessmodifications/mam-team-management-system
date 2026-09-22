import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const react = require("react");

function load(path, overrides = {}) {
  const compiled = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", compiled)((id) => {
    if (id in overrides) return overrides[id];
    if (id === "@/components/account-status-batch") return load("src/components/account-status-batch.ts");
    if (id === "@/components/ui/animated-status-badge") return { AnimatedStatusBadge: ({ children }) => createElement("span", {}, children) };
    if (id.endsWith(".module.css")) return { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) };
    return require(id);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const account = (id, status = "active") => ({ personId: id, userId: status === "unlinked" ? undefined : `user-${id}`, name: `Employee ${id}`, position: "Tester", company: "mam", status, loginName: status === "unlinked" ? undefined : `${id}@example.test`, accountVersion: 5 });
const defaults = { onCreateAccount: async () => {}, onUpdateLogin: async () => {}, onResetPassword: async () => {}, onToggleEnabled: async () => {} };

function findAll(node, predicate) {
  if (Array.isArray(node)) return node.flatMap((item) => findAll(item, predicate));
  if (!node || typeof node !== "object") return [];
  return [...(predicate(node) ? [node] : []), ...findAll(node.props?.children, predicate)];
}
const find = (node, predicate) => findAll(node, predicate)[0];
const text = (node) => Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" ? text(node.props?.children) : String(node ?? "");
const button = (tree, label) => find(tree, (node) => node.type === "button" && text(node) === label);
const checkbox = (tree, label) => find(tree, (node) => node.type === "input" && node.props["aria-label"] === label);

function harness(accounts, callbacks = {}) {
  let stateIndex = 0, refIndex = 0;
  const states = [], refs = [];
  const fakeReact = {
    ...react,
    useState(initial) {
      const index = stateIndex++;
      if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
      return [states[index], (value) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
    },
    useRef(initial) { const index = refIndex++; return refs[index] ??= { current: initial }; },
    useMemo: (factory) => factory(),
    useEffect() {},
  };
  const { AccountManagement } = load("src/components/account-management.tsx", { react: fakeReact });
  return { render() { stateIndex = 0; refIndex = 0; return AccountManagement({ accounts, ...defaults, ...callbacks }); } };
}

test("accounts render a semantic register with selection first and private actions per person", () => {
  const { AccountManagement } = load("src/components/account-management.tsx");
  const html = renderToStaticMarkup(createElement(AccountManagement, { accounts: [account("one"), account("two", "unlinked")], ...defaults }));
  assert.match(html, /<table[^>]*aria-label="Login accounts"/);
  assert.match(html, /<thead><tr><th[^>]*>[\s\S]*Select all visible accounts[\s\S]*<span>Select<\/span>[\s\S]*<th scope="col">Employee<\/th>/);
  for (const label of ["Company", "Login email", "Status", "Last sign-in", "Actions"]) assert.match(html, new RegExp(`<th scope="col">${label}<\\/th>`));
  assert.match(html, /aria-label="Select Employee two"[^>]*disabled=""/);
  assert.match(html, /Change login/);
  assert.match(html, /Reset password/);
  assert.match(html, /Create login/);
  assert.doesNotMatch(html, /Export|bulk password|Bulk password/);
});

test("select all applies only to linked accounts on the visible page and page changes clear selection", () => {
  const accounts = Array.from({ length: 15 }, (_, index) => account(String(index).padStart(2, "0")));
  accounts[4] = account("04", "unlinked");
  const h = harness(accounts);
  checkbox(h.render(), "Select all visible accounts").props.onChange({ target: { checked: true } });
  let tree = h.render();
  assert.ok(text(tree).includes("11 selected"));
  assert.equal(checkbox(tree, "Select Employee 04").props.checked, false);
  find(tree, (node) => node.type === "button" && node.props["aria-label"] === "Next page").props.onClick();
  tree = h.render();
  assert.equal(find(tree, (node) => node.props?.["aria-label"] === "Selected accounts"), undefined);
  assert.equal(checkbox(tree, "Select Employee 12").props.checked, false);
});

test("bulk status changes require confirmation and preserve failed rows while reporting successes", async () => {
  const calls = [];
  const h = harness([account("one"), account("two"), account("three", "disabled")], {
    async onToggleEnabled(input) {
      calls.push(input);
      if (input.personId === "two") throw new Error("Account changed. Refresh and try again.");
      return { account: { ...account(input.personId, input.enabled ? "active" : "disabled"), accountVersion: 6 } };
    },
  });
  checkbox(h.render(), "Select all visible accounts").props.onChange({ target: { checked: true } });
  button(h.render(), "Disable logins").props.onClick();
  let tree = h.render();
  assert.equal(calls.length, 0, "choosing a bulk action must not save immediately");
  assert.ok(text(tree).includes("Disable 2 logins?"));
  assert.ok(text(tree).includes("These people will be signed out and unable to sign in."));
  assert.equal(checkbox(tree, "Select all visible accounts").props.disabled, true);
  await button(tree, "Disable 2 logins").props.onClick();
  tree = h.render();
  assert.deepEqual(calls.map((input) => input.personId), ["one", "two"]);
  assert.ok(calls.every((input) => input.accountVersion === 5 && input.enabled === false));
  assert.ok(text(tree).includes("1 login disabled. 1 not confirmed; still selected."));
  assert.equal(checkbox(tree, "Select Employee one").props.checked, false);
  assert.equal(checkbox(tree, "Select Employee two").props.checked, true);
  assert.equal(checkbox(tree, "Select Employee three").props.checked, false);
  assert.ok(text(tree).includes("Account changed. Refresh and try again."));
});

test("search changes clear selection so hidden accounts are not included", () => {
  const h = harness([account("one"), account("two")]);
  checkbox(h.render(), "Select all visible accounts").props.onChange({ target: { checked: true } });
  find(h.render(), (node) => node.type === "input" && node.props.type === "search").props.onChange({ target: { value: "one" } });
  const tree = h.render();
  assert.equal(checkbox(tree, "Select Employee one").props.checked, false);
  assert.equal(find(tree, (node) => node.props?.["aria-label"] === "Selected accounts"), undefined);
});

test("bulk submissions are sequential and a repeated confirm cannot start duplicate writes", async () => {
  const calls = [], releases = [];
  const h = harness([account("one"), account("two")], {
    onToggleEnabled(input) {
      calls.push(input.personId);
      return new Promise((resolve) => releases.push(() => resolve({ account: { ...account(input.personId, "disabled"), accountVersion: 6 } })));
    },
  });
  checkbox(h.render(), "Select all visible accounts").props.onChange({ target: { checked: true } });
  button(h.render(), "Disable logins").props.onClick();
  const confirm = button(h.render(), "Disable 2 logins");
  const first = confirm.props.onClick();
  await confirm.props.onClick();
  assert.deepEqual(calls, ["one"]);
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["one", "two"]);
  releases.shift()();
  await first;
  assert.ok(text(h.render()).includes("2 logins disabled."));
});

test("batch keeps server rejections and missing confirmations unresolved without touching unlinked accounts", async () => {
  const { applyAccountStatusBatch } = load("src/components/account-status-batch.ts");
  const calls = [];
  const result = await applyAccountStatusBatch([account("self"), account("missing"), account("none", "unlinked"), account("ok", "disabled")], true, async (input) => {
    calls.push(input.personId);
    if (input.personId === "self") throw new Error("You cannot change your own account status.");
    if (input.personId === "missing") return;
    return { account: { ...account(input.personId), accountVersion: 6 } };
  });
  assert.deepEqual(calls, ["self", "missing", "ok"]);
  assert.deepEqual(result.confirmed.map((saved) => saved.personId), ["ok"]);
  assert.deepEqual(result.failures.map((failure) => failure.personId), ["self", "missing", "none"]);
  assert.match(result.failures[1].message, /not confirmed/);
});
