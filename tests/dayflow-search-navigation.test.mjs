import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync("src/lib/dayflow-search-navigation.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
vm.runInNewContext(compiled, { exports: loaded.exports, module: loaded });
const { navigateFromDayFlowSearchResult } = loaded.exports;

test("mobile search closes before its deferred calendar navigation", () => {
  const calls = [];
  let nextFrame;
  navigateFromDayFlowSearchResult({
    source: "mobile",
    closeSearch: () => calls.push("close"),
    defaultAction: () => calls.push("navigate"),
  }, (callback) => { nextFrame = callback; });

  assert.deepEqual(calls, ["close"]);
  assert.equal(typeof nextFrame, "function");
  nextFrame();
  assert.deepEqual(calls, ["close", "navigate"]);
});

test("desktop search retains DayFlow's immediate default action", () => {
  const calls = [];
  navigateFromDayFlowSearchResult({
    source: "desktop",
    closeSearch: () => calls.push("close"),
    defaultAction: () => calls.push("navigate"),
  }, () => { throw new Error("desktop navigation must not be deferred"); });
  assert.deepEqual(calls, ["navigate"]);
});

test("the calendar wires the guarded result-navigation handler", () => {
  const component = readFileSync("src/components/team-calendar.tsx", "utf8");
  assert.match(component, /onResultClick:\s*navigateFromDayFlowSearchResult/);
});
