import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/components/ui/use-dialog-focus.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;

function harness(mobile = true) {
  const effects = [], listeners = new Set(), microtasks = [];
  const document = { activeElement: null, body: null, documentElement: null };
  class Element {
    constructor(controls = []) { this.controls = controls; this.attrs = {}; this.tabIndex = 0; this.isConnected = true; this.visible = true; }
    focus() { document.activeElement = this; }
    querySelectorAll() { return this.controls; }
    getAttribute(name) { return this.attrs[name] ?? null; }
    hasAttribute(name) { return name in this.attrs; }
    removeAttribute(name) { delete this.attrs[name]; }
    getClientRects() { return this.visible ? [{}] : []; }
    closest() { return null; }
    contains(element) { return element === this || this.controls.includes(element); }
  }
  document.body = new Element();
  document.body.style = { overflow: "auto" };
  document.documentElement = new Element();
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, HTMLElement: Element, document,
    queueMicrotask: fn => microtasks.push(fn),
    require: () => ({ useRef: value => ({ current: value }), useEffect: fn => effects.push(fn) }),
    window: {
      matchMedia: () => ({ matches: mobile }),
      getComputedStyle: () => ({ visibility: "visible" }),
      addEventListener: (_, fn) => listeners.add(fn),
      removeEventListener: (_, fn) => listeners.delete(fn),
    },
  });
  function mount(dialog, close = () => {}, fallbackFocusRef = null) {
    exports.useDialogFocus(true, { current: dialog }, null, close, fallbackFocusRef);
    const cleanup = effects.splice(0).map(fn => fn()).filter(Boolean);
    return () => cleanup.forEach(fn => fn());
  }
  function key(key, options = {}) {
    const event = { key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...options };
    for (const listener of listeners) listener(event);
  }
  return { Element, document, mount, key, flush: () => microtasks.splice(0).forEach(fn => fn()) };
}

test("phone dialog takes focus without opening the input keyboard", () => {
  const h = harness(), field = new h.Element(), dialog = new h.Element([field]);
  h.mount(dialog);
  assert.equal(h.document.activeElement, dialog);
  assert.equal(h.document.body.style.overflow, "hidden");
});

test("desktop initial focus and Tab skip hidden controls", () => {
  const h = harness(false), hidden = new h.Element(), first = new h.Element(), last = new h.Element();
  hidden.visible = false;
  const dialog = new h.Element([hidden, first, last]);
  h.mount(dialog);
  assert.equal(h.document.activeElement, first);
  h.key("Tab", { shiftKey: true });
  assert.equal(h.document.activeElement, last);
  h.key("Tab");
  assert.equal(h.document.activeElement, first);
});

test("only the top dialog consumes Escape; nested cleanup retains the scroll lock", () => {
  const h = harness(), trigger = new h.Element(), parent = new h.Element([trigger]);
  let parentClosed = 0, childClosed = 0;
  const closeParent = h.mount(parent, () => parentClosed++);
  trigger.focus();
  const closeChild = h.mount(new h.Element(), () => childClosed++);
  h.key("Escape");
  assert.equal(childClosed, 1);
  assert.equal(parentClosed, 0);
  closeChild(); h.flush();
  assert.equal(h.document.body.style.overflow, "hidden");
  assert.equal(h.document.activeElement, trigger);
  closeParent(); h.flush();
  assert.equal(h.document.body.style.overflow, "auto");
});

test("combobox-consumed Escape does not close its dialog", () => {
  const h = harness(); let closed = false;
  h.mount(new h.Element(), () => { closed = true; });
  h.key("Escape", { defaultPrevented: true });
  assert.equal(closed, false);
});

test("uses a connected fallback when a mutation removes the opening control", () => {
  const h = harness(), trigger = new h.Element(), fallback = new h.Element();
  const parent = new h.Element([trigger, fallback]);
  const closeParent = h.mount(parent);
  trigger.focus();
  const closeChild = h.mount(new h.Element(), () => {}, { current: fallback });
  trigger.isConnected = false;
  closeChild(); h.flush();
  assert.equal(h.document.activeElement, fallback);
  closeParent(); h.flush();
});

test("uses a fallback when a chained dialog opens from the page body", () => {
  const h = harness(), fallback = new h.Element();
  h.document.body.focus();
  const close = h.mount(new h.Element(), () => {}, { current: fallback });
  close(); h.flush();
  assert.equal(h.document.activeElement, fallback);
});

test("out-of-order unmount does not unlock a still-open child", () => {
  const h = harness();
  const parent = h.mount(new h.Element()), child = h.mount(new h.Element());
  parent();
  assert.equal(h.document.body.style.overflow, "hidden");
  child();
  assert.equal(h.document.body.style.overflow, "auto");
});
