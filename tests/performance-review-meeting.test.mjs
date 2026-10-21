import assert from 'node:assert/strict';
import test from 'node:test';
import { loadMailHarness, environment, ids, app, cronSecret } from './helpers/performance-review-mail-harness.mjs';

const path = '/api/performance-reviews/meeting';
const env = patch => environment({ MAM_PERFORMANCE_REVIEW_ENABLED: 'true', ...patch });
const input = () => ({ requestToken: ids.claim, expectedRevision: 'manager:1:2', event: {
  id: 'synthetic-event', uid: 'synthetic-uid', subject: 'RE: PR-2026-1 review meeting', organizer: 'manager@example.test',
  attendees: ['employee@example.test', 'ai@mobilityaccess.com.au'], start: '2026-10-22T00:00:00Z', end: '2026-10-22T00:30:00Z', createdAt: '2026-10-21T00:01:00Z', modifiedAt: '2026-10-21T00:02:00Z',
  mode: 'in_person', location: 'Synthetic room', isCancelled: false, isAllDay: false, type: 'singleInstance',
} });
function request(method = 'GET', body, { query = '', bearer = cronSecret, headers = {}, origin = app, suffix = '' } = {}) {
  return new Request(origin + path + suffix + query, { method, headers: { authorization: 'Bearer ' + bearer, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
}
function harness(options = {}) {
  const h = loadMailHarness({ env: env(), ...options });
  return { h, route: h.load('src/app/api/performance-reviews/meeting/route.ts'), rules: h.load('src/lib/performance-review-meeting.ts') };
}

test('retired meeting import rejects unauthenticated and wrong-target calls without service access', async () => {
  const { h, route } = harness();
  for (const method of ['GET', 'POST']) {
    assert.equal((await route[method](request(method, undefined, { bearer: 'wrong' }))).status, 401);
    assert.equal((await route[method](request(method, undefined, { origin: 'https://foreign.example.test' }))).status, 400);
    assert.equal((await route[method](request(method, undefined, { query: '?unexpected=1' }))).status, 400);
  }
  assert.equal(h.clients, 0); assert.equal(h.calls.length, 0); assert.equal(h.requests.length, 0);
});

test('retired meeting import, readiness and callbacks perform no calendar or database operations', async () => {
  for (const patch of [{}, { MAM_PERFORMANCE_REVIEW_ENABLED: 'false' }, { PERFORMANCE_REVIEW_EMAIL_MODE: 'disabled' }, { MAM_SANDBOX_E2E: 'true' }]) {
    const { h, route } = harness({ env: env(patch) });
    for (const req of [request(), request('GET', undefined, { query: '?readiness=1' }), request('POST', input()), request('POST', '{invalid')]) {
      const response = await route[req.method](req);
      assert.equal(response.status, 410);
      assert.deepEqual(await response.json(), { ok: false, code: 'manual_entry_required' });
      assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
    }
    assert.equal(h.clients, 0); assert.equal(h.calls.length, 0); assert.equal(h.requests.length, 0); assert.equal(h.logs.length, 0);
  }
});
