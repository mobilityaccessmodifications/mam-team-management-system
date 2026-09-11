import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const react = require("react");

function loadScheduleCard() {
  const source = readFileSync("src/components/work-schedule-workflow.tsx", "utf8");
  const compiled = ts.transpileModule(`${source}\nexport { ScheduleCard as __ScheduleCard };`, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;

  const values = [
    true,
    false,
    [1, 2, 3, 4, 5],
    "Synthetic reason",
    "Choose a schedule that is different from your current work days.",
    false,
  ];
  const updates = values.map(() => []);
  let stateIndex = 0;
  const fakeReact = {
    ...react,
    useId: () => `test-id-${stateIndex}`,
    useRef: (initial) => ({ current: initial ?? null }),
    useState: (initial) => {
      const index = stateIndex++;
      return [values[index] ?? initial, (next) => updates[index].push(next)];
    },
  };
  const styles = new Proxy({}, { get: (_, key) => String(key) });
  const loaded = { exports: {} };

  function resolveImport(id) {
    if (id === "react") return fakeReact;
    if (id === "@/components/ui/motion-loader") return { MotionLoader: () => null };
    if (id === "@/components/ui/use-dialog-focus") return { useDialogFocus() {} };
    if (id.endsWith(".module.css")) return { __esModule: true, default: styles };
    return require(id);
  }

  new Function("require", "module", "exports", compiled)(resolveImport, loaded, loaded.exports);
  return { ScheduleCard: loaded.exports.__ScheduleCard, updates };
}

function findElement(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  const children = node.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return null;
}

test("editing a schedule request clears stale validation feedback", () => {
  const { ScheduleCard, updates } = loadScheduleCard();
  const tree = ScheduleCard({
    workspace: {
      activePersonId: "employee",
      workingWeekdays: [1, 2, 3, 4, 5],
      canRequestChange: true,
      history: [],
    },
    async onRequest() { return { ok: true }; },
  });

  const friday = findElement(tree, (node) => node.type === "button" && node.props?.["aria-label"] === "Friday");
  assert.ok(friday, "Friday schedule control should render");
  friday.props.onClick();
  assert.deepEqual(updates[4], [""], "changing selected days should clear the prior error");

  updates[4].length = 0;
  const reason = findElement(tree, (node) => node.type === "textarea" && node.props?.placeholder === "Why do you need this change?");
  assert.ok(reason, "schedule reason field should render");
  reason.props.onChange({ target: { value: "Updated reason" } });
  assert.deepEqual(updates[3], ["Updated reason"]);
  assert.deepEqual(updates[4], [""], "editing the reason should clear the prior error");
});
