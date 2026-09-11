import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync("src/lib/dayflow-event-accessibility.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

class FakeElement {
  constructor({ parent = null, text = "", title = "" } = {}) {
    this.parent = parent;
    this.textContent = text;
    this.attrs = new Map();
    this.tabIndex = -1;
    this.clicked = false;
    this.focusOptions = null;
    this.titledChild = title ? new FakeElement({ text: title }) : null;
    if (title) this.titledChild.attrs.set("title", title);
  }
  closest(selector) {
    if (selector === "[data-event-id][data-viewable='true']" && this.attrs.has("data-event-id") && this.attrs.get("data-viewable") === "true") return this;
    return this.parent?.closest(selector) ?? null;
  }
  querySelector(selector) { return selector === "[title]" ? this.titledChild : null; }
  hasAttribute(name) { return this.attrs.has(name); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  focus(options) { this.focusOptions = options; }
  click() { this.clicked = true; }
}

const loaded = { exports: {} };
vm.runInNewContext(compiled, { exports: loaded.exports, module: loaded, Element: FakeElement });
const {
  activateDayFlowEventFromKeyboard,
  focusDayFlowEventFromTarget,
  makeDayFlowEventsAccessible,
} = loaded.exports;

function eventElement(title = "Alice Employee · Annual leave (12/10/2026 - 13/10/2026)") {
  const event = new FakeElement({ title });
  event.attrs.set("data-event-id", "leave:synthetic");
  event.attrs.set("data-viewable", "true");
  return event;
}

test("DayFlow events gain button semantics and a useful accessible name", () => {
  const event = eventElement();
  makeDayFlowEventsAccessible({ querySelectorAll: () => [event] });
  assert.equal(event.getAttribute("role"), "button");
  assert.equal(event.tabIndex, 0);
  assert.equal(event.getAttribute("aria-label"), "Alice Employee · Annual leave (12/10/2026 - 13/10/2026)");
});

test("pointer interaction focuses the event before the detail dialog opens", () => {
  const event = eventElement();
  const child = new FakeElement({ parent: event });
  assert.equal(focusDayFlowEventFromTarget(child), event);
  assert.equal(event.focusOptions?.preventScroll, true);
});

test("Enter and Space activate a focused event", () => {
  for (const key of ["Enter", " "]) {
    const event = eventElement();
    assert.equal(activateDayFlowEventFromKeyboard(event, key), true);
    assert.equal(event.clicked, true);
  }
  const event = eventElement();
  assert.equal(activateDayFlowEventFromKeyboard(event, "Escape"), false);
  assert.equal(event.clicked, false);
});
