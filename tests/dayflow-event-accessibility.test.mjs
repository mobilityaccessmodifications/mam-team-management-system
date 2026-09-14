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
  makeDayFlowNavigationAccessible,
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

test("calendar navigation names match the active DayFlow view", () => {
  const expectations = new Map([
    ["Day", ["Previous day", "Next day"]],
    ["Week", ["Previous week", "Next week"]],
    ["Month", ["Previous month", "Next month"]],
    ["Year", ["Previous year", "Next year"]],
    ["Agenda", ["Previous 14 days", "Next 14 days"]],
  ]);

  for (const [view, labels] of expectations) {
    const activeView = new FakeElement({ text: view });
    const previous = new FakeElement();
    const next = new FakeElement();
    previous.setAttribute("aria-label", "Previous month");
    next.setAttribute("aria-label", "Next month");
    const root = {
      querySelector: (selector) => selector === ".df-view-switcher-btn[data-active='true']" ? activeView : null,
      querySelectorAll: (selector) => selector === ".df-calendar-nav-button" ? [previous, next] : [],
    };

    makeDayFlowNavigationAccessible(root);

    assert.equal(previous.getAttribute("aria-label"), labels[0], `${view} previous button`);
    assert.equal(next.getAttribute("aria-label"), labels[1], `${view} next button`);
  }
});

test("calendar semantics observe active-view changes", () => {
  const component = readFileSync("src/components/team-calendar.tsx", "utf8");
  assert.match(component, /attributes:\s*true/);
  assert.match(component, /attributeFilter:\s*\["data-active"\]/);
});
