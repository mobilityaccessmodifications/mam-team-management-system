import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const profiles = [
  { id: 'director', name: 'Director Example', position: 'Director', company: 'mam', reportsTo: null, version: 1 },
  { id: 'manager', name: 'Manager Example', position: 'Team Leader', company: 'mam', reportsTo: 'director', version: 2 },
  { id: 'starter', name: 'Starter Example', position: 'Installer', company: 'mam', reportsTo: null, version: 3 },
];
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
function harness(canEdit = true, extraRoots = [], failure = null) {
  const states = [], refs = [], calls = [];
  let stateCursor = 0, refCursor = 0;
  const rectangles = { director: { left: 100, top: 100, right: 288, bottom: 164, width: 188, height: 64 }, manager: { left: 100, top: 300, right: 288, bottom: 364, width: 188, height: 64 }, starter: { left: 600, top: 100, right: 788, bottom: 164, width: 188, height: 64 } };
  const root = { querySelectorAll: () => profiles.map(({ id }) => ({ dataset: { nodeId: id }, getBoundingClientRect: () => rectangles[id] })) };
  const frames = [];
  const window = { setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame: fn => { frames.push(fn); return frames.length; }, cancelAnimationFrame() {}, matchMedia: () => ({ matches: false }) };
  const viewport = { clientWidth: 1000, clientHeight: 600, scrollLeft: 0, scrollTop: 0, scrollTo(value) { this.scrollLeft = value.left; this.scrollTop = value.top; } };
  const document = { fullscreenElement: root };
  const react = { ...require('react'), useEffect() {}, useId: () => 'chart-test', useCallback: fn => fn, useMemo: fn => fn(),
    useState(initial) { const index = stateCursor++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; },
    useRef(initial) { const index = refCursor++; if (!(index in refs)) refs[index] = { current: initial }; return refs[index]; },
  };
  const mod = { exports: {} };
  const source = ts.transpileModule(readFileSync('src/components/organisation-tree.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Function('require', 'module', 'exports', 'window', 'document', source)(id => {
    if (id === 'react') return react;
    if (id.endsWith('.css')) return { default: new Proxy({}, { get: (_, key) => key }) };
    if (id === '@/lib/organisation-layout') return { defaultBranchLayout: () => 'horizontal', defaultDisplayChildren: node => node.children };
    if (id === '@/components/ui/use-dialog-focus') return { useDialogFocus() {} };
    if (id.startsWith('@/')) return {};
    return require(id);
  }, mod, mod.exports, window, document);
  const props = { profiles: [...profiles, ...extraRoots], canArrange: true, canEdit, onUpdate: async (...args) => { calls.push(args); if (failure) throw new Error(failure); } };
  function render() {
    stateCursor = 0; refCursor = 0;
    const tree = mod.exports.OrganisationTree(props);
    tree.props.ref.current = root;
    nodes(tree).find(node => node.props?.className === 'treeViewport').props.ref.current = viewport;
    return tree;
  }
  function card(tree, id) { return nodes(nodes(tree).find(node => node.props?.['data-node-id'] === id)).find(node => node?.props?.className === 'personCard'); }
  const capture = { setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} };
  const event = (type, clientX, clientY) => ({ type, clientX, clientY, pointerId: 1, button: 0, currentTarget: capture, preventDefault() {}, stopPropagation() {} });
  return { calls, card, event, render, viewport, flushFrames: () => frames.splice(0).forEach(fn => fn()), async arrange() { const tree = render(); await nodes(tree).find(node => node.type === 'button' && node.props.children?.includes?.('Arrange')).props.onClick(); return render(); } };
}

test('releasing a root starter below a manager uses the release target, not the last move position', async () => {
  const h = harness();
  let tree = await h.arrange();
  h.card(tree, 'starter').props.onPointerDown(h.event('pointerdown', 694, 132));
  h.card(tree, 'starter').props.onPointerMove(h.event('pointermove', 500, 240));
  tree = h.render();
  h.card(tree, 'starter').props.onPointerUp(h.event('pointerup', 194, 382));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls, [['starter', { name: 'Starter Example', position: 'Installer', company: 'mam', reportsTo: 'manager', kind: 'person', expectedVersion: 3 }]]);
});

test('Fit includes disconnected starter roots even when the forest is wider than the manual minimum zoom', () => {
  const roots = Array.from({ length: 12 }, (_, index) => ({ ...profiles[2], id: `unassigned-${index}`, name: `Starter ${index} Example` }));
  const h = harness(true, roots);
  const controls = nodes(h.render()).find(node => node.props?.fitChart);
  controls.props.fitChart();
  h.flushFrames();
  const tree = h.render();
  const world = nodes(tree).find(node => node.props?.className === 'chartWorld');
  const fitted = nodes(tree).find(node => node.props?.fitChart);
  assert.ok(world.props.style.width * fitted.props.zoom <= h.viewport.clientWidth - 48, 'all roots fit horizontally');
  assert.ok(world.props.style.height * fitted.props.zoom <= h.viewport.clientHeight - 86, 'all roots fit vertically');
  assert.ok(fitted.props.minZoom <= fitted.props.zoom, 'zoom controls accept the fitted overview scale');
  assert.equal(h.viewport.scrollLeft, 0);
  assert.deepEqual(h.calls, []);
});

for (const type of ['pointercancel', 'lostpointercapture']) {
  test(`${type} never persists a reporting relationship`, async () => {
    const h = harness();
    const tree = await h.arrange();
    const card = h.card(tree, 'starter');
    card.props.onPointerDown(h.event('pointerdown', 694, 132));
    card.props.onPointerMove(h.event('pointermove', 194, 382));
    card.props[type === 'pointercancel' ? 'onPointerCancel' : 'onLostPointerCapture'](h.event(type, 194, 382));
    assert.deepEqual(h.calls, []);
  });
}

test('releasing in blank space does not persist a stale hovered manager', async () => {
  const h = harness();
  const tree = await h.arrange();
  const card = h.card(tree, 'starter');
  card.props.onPointerDown(h.event('pointerdown', 694, 132));
  card.props.onPointerMove(h.event('pointermove', 194, 382));
  card.props.onPointerUp(h.event('pointerup', 500, 240));
  assert.deepEqual(h.calls, []);
});

test('a reporting descendant cannot become the dragged person\'s manager', async () => {
  const h = harness();
  const tree = await h.arrange();
  const card = h.card(tree, 'director');
  card.props.onPointerDown(h.event('pointerdown', 194, 132));
  card.props.onPointerMove(h.event('pointermove', 194, 382));
  card.props.onPointerUp(h.event('pointerup', 194, 382));
  assert.deepEqual(h.calls, []);
});

test('visual-only Arrange cannot persist a relationship', async () => {
  const h = harness(false);
  const tree = await h.arrange();
  const card = h.card(tree, 'starter');
  card.props.onPointerDown(h.event('pointerdown', 694, 132));
  card.props.onPointerMove(h.event('pointermove', 194, 382));
  card.props.onPointerUp(h.event('pointerup', 194, 382));
  assert.deepEqual(h.calls, []);
});

test('protected onboarding drop restores only the dragged card and explains the unsaved reporting line', async () => {
  const h = harness(true, [], 'Onboarding credential delivery in progress');
  let tree = await h.arrange();
  let card = h.card(tree, 'director');
  card.props.onPointerDown(h.event('pointerdown', 194, 132));
  card.props.onPointerMove(h.event('pointermove', 500, 240));
  card.props.onPointerUp(h.event('pointerup', 500, 240));
  tree = h.render();
  const wrap = (value, id) => nodes(value).find(node => node.props?.['data-node-id'] === id);
  const directorPosition = wrap(tree, 'director').props.style.transform;
  card = h.card(tree, 'starter');
  card.props.onPointerDown(h.event('pointerdown', 694, 132));
  card.props.onPointerMove(h.event('pointermove', 500, 240));
  card.props.onPointerUp(h.event('pointerup', 500, 240));
  tree = h.render();
  const originalPosition = wrap(tree, 'starter').props.style.transform;
  card = h.card(tree, 'starter');
  card.props.onPointerDown(h.event('pointerdown', 694, 132));
  card.props.onPointerMove(h.event('pointermove', 194, 382));
  card.props.onPointerUp(h.event('pointerup', 194, 382));
  await new Promise(resolve => setImmediate(resolve));
  tree = h.render();
  assert.equal(wrap(tree, 'starter').props.style.transform, originalPosition, 'pre-drag manual position restored');
  assert.equal(wrap(tree, 'director').props.style.transform, directorPosition, 'unrelated arrangement retained');
  const dialog = nodes(tree).find(node => node.props?.role === 'dialog');
  assert.ok(dialog, 'protected lock explanation popup');
  assert.equal(dialog.props['aria-modal'], 'true');
  assert.ok(dialog.props['aria-labelledby']);
  assert.ok(dialog.props['aria-describedby']);
  const allText = JSON.stringify(dialog.props.children);
  assert.match(allText, /Connection not saved/);
  assert.match(allText, /account-credential email is being processed or needs administrator review/);
  assert.match(allText, /protection lock temporarily prevents reporting-line changes/);
  assert.match(allText, /card has returned to its previous position/);
  assert.match(allText, /No reporting relationship was changed/);
  assert.equal(h.calls.length, 1);
  nodes(dialog).find(node => node.type === 'button' && node.props.children === 'Got it').props.onClick();
  assert.equal(nodes(h.render()).some(node => node.props?.role === 'dialog'), false);
  assert.equal(h.calls.length, 1, 'acknowledgement never retries or unlocks');
});

for (const releaseY of [382, 282]) {
  test(`protected drop at ${releaseY} removes only a newly created dragged offset`, async () => {
    const h = harness(true, [], 'Onboarding credential delivery in progress');
    let tree = await h.arrange();
    const card = h.card(tree, 'starter');
    card.props.onPointerDown(h.event('pointerdown', 694, 132));
    card.props.onPointerMove(h.event('pointermove', 194, releaseY));
    card.props.onPointerUp(h.event('pointerup', 194, releaseY));
    await new Promise(resolve => setImmediate(resolve));
    tree = h.render();
    const wrap = nodes(tree).find(node => node.props?.['data-node-id'] === 'starter');
    assert.equal(wrap.props['data-manual'], false);
    assert.equal(wrap.props.style.transform, 'translate3d(0px, 0px, 0)');
    assert.equal(h.calls[0][0], releaseY === 282 ? 'manager' : 'starter', 'both reporting intents restore dragged card');
  });
}

test('unknown persistence errors return the card and provide a sanitized actionable reason without claiming a lock', async () => {
  const h = harness(true, [], 'private-token-and-provider-error');
  let tree = await h.arrange();
  const card = h.card(tree, 'starter');
  card.props.onPointerDown(h.event('pointerdown', 694, 132));
  card.props.onPointerMove(h.event('pointermove', 194, 382));
  card.props.onPointerUp(h.event('pointerup', 194, 382));
  await new Promise(resolve => setImmediate(resolve));
  tree = h.render();
  const dialog = nodes(tree).find(node => node.props?.role === 'dialog');
  assert.ok(dialog);
  assert.equal(nodes(tree).find(node => node.props?.['data-node-id'] === 'starter').props['data-manual'], false);
  assert.match(JSON.stringify(dialog.props.children), /Refresh the chart and try again/);
  assert.doesNotMatch(JSON.stringify(tree.props.children), /private-token-and-provider-error|credential email|protection lock/i);
  assert.equal(h.calls.length, 1);
});

test('root starter Add line sends the current version and only the chosen parent', async () => {
  const h = harness();
  let tree = h.render();
  nodes(tree).find(node => node.props?.['aria-label'] === 'Add or edit Starter Example\'s reporting line').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  tree = h.render();
  nodes(tree).find(node => node.props?.['aria-label'] === 'Make Starter Example report to Manager Example').props.onClick({ stopPropagation() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], 'starter');
  assert.equal(h.calls[0][1].reportsTo, 'manager');
  assert.equal(h.calls[0][1].expectedVersion, 3);
});
