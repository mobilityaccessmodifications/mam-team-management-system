import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import * as React from "react";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(file, overrides) {
  const js = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", js)((id) => {
    if (Object.hasOwn(overrides, id)) return overrides[id];
    if (id === "server-only") return {};
    if (id.endsWith(".css")) return { __esModule: true, default: {} };
    assert.ok(!id.startsWith("@/"), `unexpected dependency ${id}`);
    return require(id);
  }, mod, mod.exports);
  return mod.exports;
}

const workspace = {
  canImport: true, canManageAccess: false,
  reminder: { dueOn: "2026-10-01", mamAsOf: null, equipsyAsOf: null, mamComplete: false, equipsyComplete: false, complete: false },
  recentBatches: [],
};
const ready = { status: "ready", workspace };
const batch = { batchId: "synthetic-batch", status: "staged", version: 1, comparisonOnly: false, rows: [], files: [], comparisonRows: [] };
const loadError = { status: "error", message: "Payroll balance import could not be loaded. Refresh and try again." };

function action({ data = workspace, error = null, sessionError = null, throwRpc = false } = {}) {
  const rpcCalls = [];
  const loaded = load("src/app/payroll-balances/actions.ts", {
    "next/cache": {}, "@/lib/payroll-balance-import": {}, "@/lib/payroll-balance-source-archive": {},
    "@/lib/supabase/admin": { createAdminClient() { assert.fail("workspace reads must not use an admin client"); } },
    "@/lib/supabase/server": { createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: { id: "synthetic-user" } }, error: sessionError }) },
      rpc: async (name) => { rpcCalls.push(name); if (throwRpc) throw new Error("connection reset"); return { data, error }; },
    }) },
  });
  return { run: loaded.getPayrollBalanceImportWorkspace, rpcCalls };
}

test("U03: only explicit capability denial maps to forbidden; transport and malformed payloads are errors", async () => {
  for (const options of [
    { error: { code: "PGRST000" } }, { error: { code: "42501" } }, { data: null }, { data: {} },
    { data: { ...workspace, canImport: "false" } }, { data: { ...workspace, recentBatches: null } },
    { data: { ...workspace, reminder: {} } }, { throwRpc: true }, { sessionError: new Error("session unavailable") },
  ]) assert.deepEqual(await action(options).run(), loadError);
  const forbidden = action({ data: { canImport: false, canManageAccess: false } });
  assert.deepEqual(await forbidden.run(), { status: "forbidden" });
  assert.deepEqual(forbidden.rpcCalls, ["get_payroll_balance_import_workspace"]);
  assert.deepEqual(await action().run(), ready);
});

const nodes = (value) => !value || typeof value !== "object" ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value, ...nodes(value.props?.children)];
const text = (value) => value == null || typeof value === "boolean" ? "" : typeof value !== "object" ? String(value)
  : Array.isArray(value) ? value.map(text).join("") : text(value.props?.children);
const findButton = (tree, label) => nodes(tree).find((node) => node.type === "button" && text(node).includes(label));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const flush = () => new Promise((resolve) => setImmediate(resolve));

// Retain hook state across real component callback execution; all server actions
// are synthetic. This verifies lifecycle state, not native browser focus order.
function importer(results) {
  let cursor = 0;
  const hooks = [], effects = [], focus = [];
  const takeHook = (initial) => { const index = cursor++; return [index, hooks[index] ??= initial]; };
  const react = {
    ...React,
    useState(initial) {
      const [index, state] = takeHook({ value: initial });
      return [state.value, (next) => { hooks[index].value = typeof next === "function" ? next(hooks[index].value) : next; }];
    },
    useRef(initial) { return takeHook({ current: initial })[1]; },
    useCallback(callback) { return callback; },
    useMemo(callback) { return callback(); },
    useEffect(callback) { const [, state] = takeHook({ installed: false }); if (!state.installed) { state.installed = true; effects.push(callback); } },
    startTransition(callback) { callback(); },
  };
  const loaded = load("src/components/payroll-balance-importer.tsx", {
    react,
    "@/app/payroll-balances/actions": {
      getPayrollBalanceImportWorkspace: async () => { assert.ok(results.length, "unexpected workspace read"); const next = results.shift(); if (next instanceof Error) throw next; return await next; },
      stagePayrollBalanceFiles: async () => ({ ok: true, batch }),
      commitPayrollBalanceImport: async () => ({ ok: true, batch: { ...batch, status: "committed" } }),
    },
    "@/components/ui/modal-backdrop": { ModalBackdrop: "backdrop" },
    "@/components/ui/use-dialog-focus": { useDialogFocus: (open) => focus.push(open) },
  });
  return {
    render() {
      cursor = 0; focus.length = 0;
      const tree = loaded.PayrollBalanceImporter({ onSaved: async () => {} });
      const dialogs = nodes(tree).filter((node) => node.props?.role === "dialog");
      assert.equal(focus.filter(Boolean).length, dialogs.length, "focus hook is active only for rendered dialogs");
      return tree;
    },
    mount() { return effects.splice(0).map((effect) => effect()); },
    async stage(tree) {
      nodes(tree).find((node) => node.type === "input" && node.props.type === "file").props.onChange({ currentTarget: { files: [new File(["synthetic"], "fixture.csv")] } });
      await flush();
    },
  };
}

test("U03: initial RPC and network failures retain an actionable error with retry to ready", async () => {
  for (const failure of [loadError, new Error("network unavailable")]) {
    const ui = importer([failure, ready]);
    assert.match(text(ui.render()), /Checking payroll import access/);
    ui.mount(); await flush();
    let tree = ui.render();
    assert.ok(nodes(tree).some((node) => node.props?.role === "alert"));
    assert.doesNotMatch(text(tree), /do not have permission/);
    findButton(tree, "Retry payroll import").props.onClick();
    await flush(); tree = ui.render();
    assert.ok(findButton(tree, "Upload CSV or Excel"));
    assert.doesNotMatch(text(tree), /could not be loaded/);
  }
});

test("U03: staged preview survives a failed refresh and retry, without disabling its close action", async () => {
  const retry = deferred();
  const ui = importer([ready, loadError, retry.promise]);
  ui.render(); ui.mount(); await flush();
  await ui.stage(ui.render());
  let tree = ui.render();
  assert.match(text(tree), /Payroll balance preview/);
  assert.match(text(tree), /Your payroll preview is still available/);
  assert.equal(findButton(tree, "Apply matched balances").props.disabled, true);
  const close = nodes(tree).find((node) => node.props?.["aria-label"] === "Close payroll balance preview");
  assert.equal(close.props.disabled, false);
  findButton(tree, "Retry payroll import").props.onClick();
  tree = ui.render();
  assert.match(text(tree), /Refreshing payroll import/);
  assert.match(text(tree), /Payroll balance preview/);
  retry.resolve(ready); await flush(); tree = ui.render();
  assert.equal(findButton(tree, "Apply matched balances").props.disabled, false);
  close.props.onClick(); tree = ui.render();
  assert.doesNotMatch(text(tree), /Payroll balance preview/);
  assert.ok(findButton(tree, "Upload CSV or Excel"));
});

test("U03: explicit denial closes an existing preview and deactivates its focus lifecycle", async () => {
  const ui = importer([ready, { status: "forbidden" }]);
  ui.render(); ui.mount(); await flush();
  await ui.stage(ui.render());
  const tree = ui.render();
  assert.match(text(tree), /do not have permission/);
  assert.doesNotMatch(text(tree), /Payroll balance preview|Upload CSV or Excel/);
});

test("U03: unmount makes a late workspace completion inert", async () => {
  const read = deferred();
  const ui = importer([read.promise]);
  ui.render(); const [cleanup] = ui.mount();
  cleanup(); read.resolve(ready); await flush();
  assert.match(text(ui.render()), /Checking payroll import access/);
});
