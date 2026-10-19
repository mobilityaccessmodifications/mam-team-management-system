import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as React from 'react';
import { workspace } from './performance-review-fixtures.mjs';
const require = createRequire(import.meta.url);
export const sourcePath = 'src/components/performance-review-workspace.tsx';
export const nodes = tree => tree == null || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];
export const text = tree => tree == null || typeof tree === 'boolean' ? '' : typeof tree !== 'object' ? String(tree) : Array.isArray(tree) ? tree.map(text).join('') : text(tree.props?.children);
export function mount(initial = workspace(), supplied = {}, componentProps = {}) {
  assert.ok(existsSync(sourcePath), 'Native performance workspace component must exist');
  let cursor = 0, changed = false, tree, authListener;
  const hooks = [], effects = [], calls = [], downloads = [], revoked = [], built = [], blobs = new Map(), timers = new Map();
  let nextTimer = 0;
  const take = initial => { const i = cursor++; return [i, hooks[i] ??= initial]; };
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = { ...React,
    useState(initial) { const [, s] = take({ value: typeof initial === 'function' ? initial() : initial }); return [s.value, v => { const next = typeof v === 'function' ? v(s.value) : v; if (!Object.is(next, s.value)) changed = true; s.value = next; }]; },
    useRef(initial) { return take({ current: initial })[1]; },
    useEffect(callback, deps) { const [, s] = take({}); s.effect = callback; if (!same(s.deps, deps)) { s.deps = deps; effects.push(() => { s.cleanup?.(); s.cleanup = callback(); }); } },
    useMemo(fn, deps) { const [, s] = take({}); if (!same(s.deps, deps)) { s.value = fn(); s.deps = deps; } return s.value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
  };
  const methods = ['loadPerformanceReviews', 'startPerformanceReview', 'mutatePerformanceReview', 'reconcilePerformanceReviewOperation', 'getPerformanceReviewDocument'];
  const ports = { loadPerformanceReviews: async () => ({ ok: true, data: initial }), ...supplied };
  const actions = Object.fromEntries(methods.map(name => [name, async (...args) => { calls.push({ name, args: structuredClone(args) }); if (!ports[name]) throw new Error('Unexpected action '+name); return ports[name](...args); }]));
  const fakeURL = { createObjectURL(blob) { const url = 'blob:synthetic-'+blobs.size; blobs.set(url, blob); return url; }, revokeObjectURL(url) { revoked.push(url); } };
  const fakeDocument = { createElement(tag) { assert.equal(tag, 'a'); const a = { click() { downloads.push({ href: a.href, fileName: a.download, blob: blobs.get(a.href) }); }, remove() {} }; return a; }, body: { appendChild() {} } };
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const mod = { exports: {} }; cache.set(file, mod);
    const raw = readFileSync(file, 'utf8');
    const code = ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    new Function('require', 'module', 'exports', 'URL', 'document', 'setTimeout', 'clearTimeout', code)(id => {
      if (id === 'react') return react;
      if (id === '@/app/performance-reviews/actions') return actions;
      if (id === '@/lib/supabase/client') return { createClient: () => ({ auth: { onAuthStateChange(callback) { authListener = callback; return { data: { subscription: { unsubscribe() { authListener = null; } } } }; } } }) };
      if (id === '@/lib/performance-review-document') { const adapter = load('src/lib/performance-review-document.ts'); return { buildPerformanceReviewDownload(doc) { built.push(doc); return adapter.buildPerformanceReviewDownload(doc); } }; }
      if (id.endsWith('.css')) return { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) };
      if (id.startsWith('@/')) return require('../src/'+id.slice(2));
      if (id.startsWith('./performance-review-')) return require('../src/lib/'+id.slice(2));
      return require(id);
    }, mod, mod.exports, fakeURL, fakeDocument, fn => { const key = ++nextTimer; timers.set(key, fn); return key; }, key => timers.delete(key));
    return mod.exports;
  }
  const Component = load(sourcePath).default;
  assert.equal(typeof Component, 'function', 'Native performance workspace must default export a React component');
  function expand(element) {
    if (Array.isArray(element)) return element.map(expand);
    if (!element || typeof element !== 'object') return element;
    if (typeof element.type === 'function') return expand(element.type(element.props));
    return { ...element, props: { ...element.props, children: expand(element.props?.children) } };
  }
  function render() { let turns = 0; do { changed = false; cursor = 0; tree = expand(Component(componentProps)); for (const effect of effects.splice(0)) effect(); assert.ok(++turns < 30, 'Hook render must settle'); } while (changed); return tree; }
  async function settle() { for (let i = 0; i < 6; i++) { await new Promise(r => setImmediate(r)); render(); } return tree; }
  const api = { calls, ports, downloads, revoked, built, blobs, hooks, render, settle,
    setProps(props) { componentProps = props; render(); },
    get tree() { return tree; },
    get all() { return nodes(tree); },
    get text() { return text(tree); },
    button(label) { const node = nodes(tree).find(n => n.type === 'button' && (n.props['aria-label'] ?? text(n)) === label); assert.ok(node, 'Button exists: '+label); return node; },
    field(name) { const node = nodes(tree).find(n => ['textarea','input','select'].includes(n.type) && (n.props.name === name || n.props['aria-label'] === name)); assert.ok(node, 'Field exists: '+name); return node; },
    click(label) { return api.button(label).props.onClick?.(); },
    change(name, value) { const node = api.field(name); node.props.onChange({ target: { value, checked: value } }); render(); },
    submit(label) { const node = nodes(tree).find(n => n.type === 'form' && n.props['aria-label'] === label); assert.ok(node, 'Form exists: '+label); return node.props.onSubmit({ preventDefault() {} }); },
    auth(event, userId = null) { assert.ok(authListener, 'Uses native Auth lifecycle'); authListener(event, userId ? { user: { id: userId } } : null); render(); },
    timers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); render(); },
    replayEffects() { hooks.forEach(s => { if (s.effect) { s.cleanup?.(); s.cleanup = s.effect(); } }); render(); },
    unmount() { hooks.forEach(s => s.cleanup?.()); },
  };
  render(); return api;
}
