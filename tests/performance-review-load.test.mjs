import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server.js';
import { loadModule, deferred } from './helpers/contact-lifetime-harness.mjs';
import { productionActionHarness, enabled, actorId, personId, managerId, review } from './performance-review-production-ui-fixture.mjs';
import { loadMailProxyHarness } from './helpers/performance-review-mail-proxy-harness.mjs';

const endpoint = 'https://portal.example.test/api/performance-reviews/workspace';
const data = { viewerContext: { actorUserId: actorId, personId, role: 'employee', displayName: 'Synthetic employee' }, reviews: [review('employee')], startablePeople: [] };
const routeFor = actions => loadModule('src/app/api/performance-reviews/workspace/route.ts', { '@/app/performance-reviews/actions': actions });
function uncached(response) {
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store, max-age=0');
  assert.equal(response.headers.get('Vary'), 'Cookie');
}

test('workspace GET uses the existing authenticated closed projection without triggering mail or writes', async () => enabled(async () => {
  const h = productionActionHarness({ role: 'employee', response: { data, error: null, status: 200 } });
  const route = routeFor(h.actions);
  assert.equal(route.dynamic, 'force-dynamic');
  assert.deepEqual(Object.keys(route).sort(), ['GET', 'dynamic']);
  const response = await route.GET(new Request(endpoint));
  assert.equal(response.status, 200); uncached(response);
  assert.deepEqual(await response.json(), { ok: true, data });
  assert.equal(h.authCalls(), 1);
  assert.deepEqual(h.calls.map(call => call.name), ['get_portal_role_capabilities', 'performance_review_workspace']);
  assert.equal(h.registrations.length + h.dispatches.length + h.notificationDispatches.length, 0);
}));

test('workspace GET fails closed for disabled, missing session, denied permissions and malformed provider data', async () => {
  for (const [options, flag, status, code] of [
    [{}, 'false', 503, 'unavailable'],
    [{ signedIn: false }, 'true', 401, 'unauthenticated'],
    [{ canonicalError: { code: '42501', message: 'PRIVATE' } }, 'true', 403, 'forbidden'],
    [{ canonicalData: [] }, 'true', 503, 'unavailable'],
    [{ response: { data: { ...data, secret: 'PRIVATE' }, error: null, status: 200 } }, 'true', 503, 'unavailable'],
    [{ response: { data, error: null, status: 500 } }, 'true', 503, 'unavailable'],
  ]) await enabled(async () => {
    const h = productionActionHarness({ role: 'employee', ...options });
    const response = await routeFor(h.actions).GET(new Request(endpoint));
    assert.equal(response.status, status); uncached(response);
    const result = await response.json(); assert.equal(result.code, code); assert.equal(result.uncertain, false);
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
    if (flag === 'false' || options.signedIn === false || options.canonicalError) assert.equal(h.business().length, 0);
  }, flag);
});

test('workspace GET rejects invalid, duplicate or authority-like query fields without a business read', async () => enabled(async () => {
  for (const query of ['?previewPersonId=', '?previewPersonId=invalid', `?previewPersonId=${personId}&previewPersonId=${managerId}`, '?actorUserId=other', '?role=system_admin', '?employeePersonId=other']) {
    const h = productionActionHarness();
    const response = await routeFor(h.actions).GET(new Request(endpoint + query));
    assert.equal(response.status, 400, query); uncached(response);
    assert.equal((await response.json()).code, 'invalid');
    assert.equal(h.authCalls(), 0); assert.equal(h.calls.length, 0);
  }
  const h = productionActionHarness({ role: 'manager' });
  const response = await routeFor(h.actions).GET(new Request(endpoint + '?previewPersonId=' + personId));
  assert.equal(response.status, 403); assert.equal(h.business().length, 0);
}));

test('workspace GET passes the preview target unchanged and sanitizes unexpected loader errors', async () => {
  let target;
  const response = await routeFor({ loadPerformanceReviews: async id => { target = id; return { ok: true, data }; } }).GET(new Request(endpoint + '?previewPersonId=' + personId));
  assert.equal(target, personId); assert.equal(response.status, 200); uncached(response);
  const unavailable = await routeFor({ loadPerformanceReviews: async () => { throw new Error('PRIVATE'); } }).GET(new Request(endpoint));
  assert.equal(unavailable.status, 503); uncached(unavailable);
  assert.ok(!(await unavailable.text()).includes('PRIVATE'));
});

test('workspace GET reaches its own session guard through proxy while sibling paths still redirect', async () => enabled(async () => {
  const h = loadMailProxyHarness();
  const response = await h.proxy(new NextRequest(endpoint));
  assert.equal(response.headers.get('x-middleware-next'), '1');
  assert.equal(h.counts.claims, 1);
  const denied = await routeFor(productionActionHarness({ signedIn: false }).actions).GET(new Request(endpoint));
  assert.equal(denied.status, 401); uncached(denied);
  for (const suffix of ['/', '/extra', '-other']) {
    const response = await h.proxy(new NextRequest(endpoint + suffix));
    assert.equal(response.status, 307);
    assert.match(new URL(response.headers.get('location')).pathname, /^\/login\/?$/);
  }
}));

test('independent workspace fetch completes while an unrelated Server Action remains pending', async t => {
  const pendingAction = deferred();
  let actionFinished = false;
  void pendingAction.promise.then(() => { actionFinished = true; });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return routeFor({ loadPerformanceReviews: async () => ({ ok: true, data }) }).GET(new Request(endpoint));
  });
  const client = loadModule('src/lib/performance-review-load.ts');
  try {
    assert.deepEqual(await client.loadPerformanceReviews(personId), { ok: true, data });
    assert.equal(actionFinished, false);
    assert.deepEqual(requests, [{ url: '/api/performance-reviews/workspace?previewPersonId=' + personId, options: { credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } } }]);
    await client.loadPerformanceReviews();
    assert.equal(requests[1].url, '/api/performance-reviews/workspace');
  } finally { pendingAction.resolve(); }
});

test('client preserves access failures and rejects invalid or failed success responses', async t => {
  let result = { ok: false, code: 'unauthenticated', uncertain: false, message: 'Sign in before using performance reviews.' };
  let status = 401;
  t.mock.method(globalThis, 'fetch', async () => Response.json(result, { status }));
  const client = loadModule('src/lib/performance-review-load.ts');
  assert.deepEqual(await client.loadPerformanceReviews(), result);
  result = { ok: true, data }; status = 503;
  await assert.rejects(client.loadPerformanceReviews(), /Reviews could not be loaded/);
  result = { unexpected: 'PRIVATE' }; status = 200;
  await assert.rejects(client.loadPerformanceReviews(), /Reviews could not be loaded/);
});
