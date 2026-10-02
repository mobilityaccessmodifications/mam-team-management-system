import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
export function loadModule(file, overrides = {}, cache = new Map()) {
  if (cache.has(file)) return cache.get(file).exports;
  if (!existsSync(file)) throw new Error('Missing real module '+file);
  const mod = { exports: {} }; cache.set(file, mod);
  const source = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  new Function('require','module','exports',source)((id) => {
    if (Object.hasOwn(overrides, id)) return overrides[id];
    if (id === 'server-only') return {};
    if (id.endsWith('.css')) return { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) };
    if (id.startsWith('@/')) return loadModule('src/'+id.slice(2)+'.ts', overrides, cache);
    return require(id);
  }, mod, mod.exports);
  return mod.exports;
}
export const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];
export const text = tree => tree == null || typeof tree === 'boolean' ? '' : typeof tree !== 'object' ? String(tree) : Array.isArray(tree) ? tree.map(text).join('') : text(tree.props?.children);
export const flush = () => new Promise(resolve => setImmediate(resolve));
export const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
export function hooksHarness(React) {
  let cursor = 0, dirty = false;
  const hooks = [], effects = [];
  const take = initial => { const index = cursor++; return [index, hooks[index] ??= initial]; };
  const depsEqual = (a,b) => a && b && a.length === b.length && a.every((value,index) => Object.is(value,b[index]));
  return {
    react: { ...React,
      useState(initial) { const [index,state] = take({ value: typeof initial === 'function' ? initial() : initial }); return [state.value, next => { const value = typeof next === 'function' ? next(hooks[index].value) : next; if (!Object.is(value, hooks[index].value)) dirty = true; hooks[index].value = value; }]; },
      useRef(initial) { return take({ current: initial })[1]; },
      useMemo(callback,deps) { const [,state] = take({}); if (!depsEqual(state.deps,deps)) { state.value = callback(); state.deps = deps; } return state.value; },
      useCallback(callback,deps) { const [,state] = take({}); if (!depsEqual(state.deps,deps)) { state.value = callback; state.deps = deps; } return state.value; },
      useEffect(callback,deps) { const [,state] = take({}); if (!depsEqual(state.deps,deps)) { state.deps = deps; effects.push(() => { state.cleanup?.(); state.cleanup = callback(); }); } },
      useLayoutEffect(callback,deps) { const [,state] = take({}); if (!depsEqual(state.deps,deps)) { state.deps = deps; effects.push(() => { state.cleanup?.(); state.cleanup = callback(); }); } },
      useId() { return take({ value: 'hook-'+cursor })[1].value; },
    },
    begin() { cursor = 0; dirty = false; },
    effects() { for (const effect of effects.splice(0)) effect(); },
    dirty() { return dirty; },
  };
}
