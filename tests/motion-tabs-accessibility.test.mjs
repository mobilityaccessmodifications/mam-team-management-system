import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/components/ui/motion-tabs.tsx", "utf8");
const styles = readFileSync("src/components/ui/motion-tabs.module.css", "utf8");

test("People section tabs expose native tab semantics and roving focus", () => {
  assert.match(source, /role="tablist"/);
  assert.match(source, /role="tab"/);
  assert.match(source, /aria-selected=\{active\}/);
  assert.match(source, /tabIndex=\{active \? 0 : -1\}/);
  assert.match(source, /event\.key === "Home"/);
  assert.match(source, /event\.key === "End"/);
});

test("tab motion is skipped for keyboard navigation and reduced motion", () => {
  assert.match(source, /data-keyboard-navigation=\{keyboardNavigation \? "true" : "false"\}/);
  assert.match(styles, /\[data-keyboard-navigation="true"\] \.indicator\s*\{[^}]*animation: none;/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.indicator\s*\{[^}]*animation: none;/);
});

test("tab selection inherits the active company palette", () => {
  assert.match(styles, /var\(--accent, var\(--mam-orange\)\)/);
  assert.match(styles, /var\(--accent-deep, var\(--mam-orange-dark\)\)/);
});

test("the selected tab is brought back into view when its container resizes", () => {
  assert.match(source, /function revealActiveTab\(\)/);
  assert.match(source, /new ResizeObserver\(revealActiveTab\)/);
  assert.match(source, /resizeObserver\.observe\(tabList\)/);
  assert.match(source, /resizeObserver\.disconnect\(\)/);
  assert.match(source, /behavior: "auto"/);
});
