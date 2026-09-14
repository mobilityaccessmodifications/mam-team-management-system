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
  constructor({ parent = null, selectors = [], text = "", title = "" } = {}) {
    this.parent = parent;
    this.selectors = new Set(selectors);
    this.textContent = text;
    this.attrs = new Map();
    this.queries = new Map();
    this.queryLists = new Map();
    this.tabIndex = -1;
    this.clicked = false;
    this.focusOptions = null;
    this.titledChild = title ? new FakeElement({ text: title }) : null;
    if (title) this.titledChild.attrs.set("title", title);
  }
  closest(selector) {
    if (selector === "[data-event-id][data-viewable='true']" && this.attrs.has("data-event-id") && this.attrs.get("data-viewable") === "true") return this;
    if (this.selectors.has(selector)) return this;
    return this.parent?.closest(selector) ?? null;
  }
  querySelector(selector) { return selector === "[title]" ? this.titledChild : this.queries.get(selector) ?? null; }
  querySelectorAll(selector) { return this.queryLists.get(selector) ?? []; }
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
  activateDayFlowSearchResultFromKeyboard,
  closeDayFlowSearchFromKeyboard,
  containDayFlowSearchFocus,
  focusDayFlowEventFromTarget,
  makeDayFlowEventsAccessible,
  makeDayFlowNavigationAccessible,
  makeDayFlowSearchAccessible,
  makeDayFlowViewSwitcherAccessible,
  restoreDayFlowDesktopSearchFocusAfterClear,
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

test("calendar view switcher exposes and updates its selected state", () => {
  const switcher = new FakeElement();
  const day = new FakeElement({ text: "Day" });
  const month = new FakeElement({ text: "Month" });
  day.setAttribute("data-active", "false");
  month.setAttribute("data-active", "true");
  const root = {
    querySelector: (selector) => selector === ".df-view-switcher" ? switcher : null,
    querySelectorAll: (selector) => selector === ".df-view-switcher-btn" ? [day, month] : [],
  };

  makeDayFlowViewSwitcherAccessible(root);

  assert.equal(switcher.getAttribute("role"), "group");
  assert.equal(switcher.getAttribute("aria-label"), "Calendar view");
  assert.equal(day.getAttribute("aria-pressed"), "false");
  assert.equal(month.getAttribute("aria-pressed"), "true");

  day.setAttribute("data-active", "true");
  month.setAttribute("data-active", "false");
  makeDayFlowViewSwitcherAccessible(root);

  assert.equal(day.getAttribute("aria-pressed"), "true");
  assert.equal(month.getAttribute("aria-pressed"), "false");
});

test("calendar semantics observe active-view changes", () => {
  const component = readFileSync("src/components/team-calendar.tsx", "utf8");
  assert.match(component, /makeDayFlowViewSwitcherAccessible\(frame\)/);
  assert.match(component, /document\.addEventListener\("click", handleSearchClick, true\)/);
  assert.match(component, /attributes:\s*true/);
  assert.match(component, /attributeFilter:\s*\["data-active"\]/);
});

function searchFixture() {
  const dialog = new FakeElement({ selectors: [".df-mobile-fullscreen"] });
  const back = new FakeElement({ parent: dialog, selectors: [".df-search-dialog-back-btn"] });
  const desktopGroup = new FakeElement({ selectors: [".df-search-group"] });
  const desktopClear = new FakeElement({ parent: desktopGroup, selectors: [".df-search-group-clear"] });
  const desktopInput = new FakeElement({ parent: desktopGroup });
  const input = new FakeElement({ parent: dialog });
  const clear = new FakeElement({ parent: dialog });
  const trigger = new FakeElement();
  dialog.queries.set(".df-search-dialog-back-btn", back);
  dialog.queries.set(".df-search-dialog-input", input);
  dialog.queries.set(".df-search-dialog-input-clear", clear);
  dialog.queryLists.set("button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])", [back, input, clear]);
  desktopGroup.queries.set(".df-search-group-input", desktopInput);
  const root = {
    querySelector: (selector) => ({
      ".df-icon-btn[title='Search']": trigger,
      ".df-search-group-clear": desktopClear,
      ".df-search-group-input": desktopInput,
      ".df-search-dialog-input": input,
    })[selector] ?? null,
    querySelectorAll: () => [],
  };
  return { back, clear, desktopClear, desktopGroup, desktopInput, dialog, input, root, trigger };
}

test("calendar search gets explicit input, dialog and control names", () => {
  const { back, clear, desktopClear, desktopInput, dialog, input, root, trigger } = searchFixture();
  makeDayFlowSearchAccessible(root);
  assert.equal(trigger.getAttribute("aria-label"), "Search calendar");
  assert.equal(desktopClear.getAttribute("aria-label"), "Clear calendar search");
  assert.equal(desktopInput.getAttribute("aria-label"), "Search calendar");
  assert.equal(dialog.getAttribute("role"), "dialog");
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(dialog.getAttribute("aria-label"), "Calendar search");
  assert.equal(input.getAttribute("aria-label"), "Search calendar");
  assert.equal(back.getAttribute("aria-label"), "Close calendar search");
  assert.equal(clear.getAttribute("aria-label"), "Clear calendar search");
});

test("desktop search clear restores focus to the input after the button is removed", () => {
  const { desktopClear, desktopInput } = searchFixture();
  let scheduled;

  assert.equal(restoreDayFlowDesktopSearchFocusAfterClear(
    desktopClear,
    (callback) => { scheduled = callback; },
  ), true);
  assert.equal(desktopInput.focusOptions, null);

  scheduled();
  assert.equal(desktopInput.focusOptions?.preventScroll, true);
  assert.equal(restoreDayFlowDesktopSearchFocusAfterClear(desktopInput, () => {}), false);
});

test("Escape closes mobile calendar search through its back control", () => {
  const { back, input } = searchFixture();
  assert.equal(closeDayFlowSearchFromKeyboard(input, "Escape"), true);
  assert.equal(back.clicked, true);
  back.clicked = false;
  assert.equal(closeDayFlowSearchFromKeyboard(input, "Enter"), false);
  assert.equal(back.clicked, false);
});

test("Tab remains inside the mobile calendar search", () => {
  const { back, clear } = searchFixture();
  assert.equal(containDayFlowSearchFocus(back, "Tab", true), true);
  assert.equal(clear.focusOptions?.preventScroll, true);
  assert.equal(containDayFlowSearchFocus(clear, "Tab", false), true);
  assert.equal(back.focusOptions?.preventScroll, true);
});

test("mobile search close restores focus to its trigger", () => {
  const component = readFileSync("src/components/team-calendar.tsx", "utf8");
  assert.match(component, /makeDayFlowSearchAccessible\(document\)/);
  assert.match(component, /requestAnimationFrame\(\(\) => searchTrigger\?\.focus\(\{ preventScroll: true \}\)\)/);
});

function searchResultFixture() {
  const group = new FakeElement({ selectors: [".df-search-results-group"] });
  const heading = new FakeElement({ text: "Sunday 2 February 2025" });
  const result = new FakeElement({ parent: group, selectors: [".df-search-results-event"] });
  const title = new FakeElement({ text: "Una Linked · Birthday" });
  const time = new FakeElement({ text: "All day" });
  group.queries.set(".df-search-results-date-header", heading);
  result.queries.set(".df-search-results-event-title", title);
  result.queries.set(".df-search-results-event-time", time);
  return { group, result };
}

test("calendar search results gain keyboard semantics and date-aware names", () => {
  const { result } = searchResultFixture();
  makeDayFlowSearchAccessible({
    querySelector: () => null,
    querySelectorAll: (selector) => selector === ".df-search-results-event" ? [result] : [],
  });
  assert.equal(result.getAttribute("role"), "button");
  assert.equal(result.tabIndex, 0);
  assert.equal(result.getAttribute("aria-label"), "Una Linked · Birthday, Sunday 2 February 2025, All day");
});

test("Enter and Space activate focused calendar search results", () => {
  for (const key of ["Enter", " "]) {
    const { result } = searchResultFixture();
    const child = new FakeElement({ parent: result });
    assert.equal(activateDayFlowSearchResultFromKeyboard(child, key), true);
    assert.equal(result.clicked, true);
  }
  const { result } = searchResultFixture();
  assert.equal(activateDayFlowSearchResultFromKeyboard(result, "Escape"), false);
  assert.equal(result.clicked, false);
});

test("closing search through a selected result also restores focus", () => {
  const component = readFileSync("src/components/team-calendar.tsx", "utf8");
  assert.match(component, /searchWasOpen && !searchIsOpen/);
});
