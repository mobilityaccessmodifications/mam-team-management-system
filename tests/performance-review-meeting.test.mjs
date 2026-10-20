import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server.js';
import { loadMailHarness, environment, ids, app, cronSecret } from './helpers/performance-review-mail-harness.mjs';
import { loadMailProxyHarness } from './helpers/performance-review-mail-proxy-harness.mjs';

const path = '/api/performance-reviews/meeting';
const env = patch => environment({ MAM_PERFORMANCE_REVIEW_ENABLED: 'true', ...patch });
const pending = () => ({ requestToken: ids.claim, reviewId: ids.review, reviewCode: 'PR-2026-1', expectedRevision: 'manager:1:2', requestedAt: '2026-10-21T00:00:00Z', managerEmail: 'manager@example.test', employeeEmail: 'employee@example.test' });
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

test('meeting HTTP handlers authenticate and check live target before constructing any privileged client', async () => {
  const { h, route } = harness();
  for (const method of ['GET', 'POST']) for (const bearer of ['', 'wrong', 'employee-session']) assert.equal((await route[method](request(method, method === 'POST' ? input() : undefined, { bearer }))).status, 401);
  for (const patch of [{ MAM_PERFORMANCE_REVIEW_ENABLED: 'false' }, { PERFORMANCE_REVIEW_EMAIL_MODE: 'disabled' }, { MAM_SANDBOX_E2E: 'true' }]) {
    const disabled = harness({ env: env(patch) });
    for (const method of ['GET', 'POST']) assert.equal((await disabled.route[method](request(method, method === 'POST' ? input() : undefined))).status, 503);
    assert.equal(disabled.h.clients, 0);
  }
  for (const options of [{ origin: 'https://foreign.example.test' }, { headers: { origin: 'https://foreign.example.test' } }, { suffix: '/extra' }, ...['?readiness=0', '?readiness=%31', '?readiness=1&readiness=1', '?reviewId=' + ids.review].map(query => ({ query }))]) assert.equal((await route.GET(request('GET', undefined, options))).status, 400);
  const ready = await route.GET(request('GET', undefined, { query: '?readiness=1' }));
  assert.deepEqual(await ready.json(), { ok: true, ready: true });
  assert.equal(ready.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.equal(h.clients, 0); assert.equal(h.requests.length, 0); assert.equal(h.logs.length, 0);
});

test('pending list returns only closed metadata and fails closed on duplicate, over-limit and private fields', async () => {
  const row = pending();
  const { h, route } = harness({ rpc(name, args) { assert.equal(name, 'list_performance_review_meeting_imports'); assert.deepEqual(args, { p_limit: 1001 }); return { data: [row], error: null }; } });
  const response = await route.GET(request()); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, requests: [row] });
  assert.deepEqual(h.rpcRetries, [false]);
  for (const data of [[row, row], [{ ...row, answers: ['private'] }], [{ ...row, managerEmail: 'Manager@example.test' }], [{ ...row, expectedRevision: 'admin:1:2' }], [{ ...row, requestedAt: 'yesterday' }], Array(1001).fill(row), null]) {
    const bad = harness({ rpc: () => ({ data, error: null }) });
    const result = await bad.route.GET(request()); assert.equal(result.status, 503); assert.deepEqual(await result.json(), { ok: false, code: 'unavailable' }); assert.equal(bad.h.logs.length, 0);
  }
});

test('formal invitation callback passes only validated metadata and exact CAS to the service RPC without retry', async () => {
  for (const status of ['imported', 'already_imported', 'skipped']) {
    const body = input();
    const { h, route } = harness({ rpc(name, args) { assert.equal(name, 'import_performance_review_meeting'); assert.deepEqual(args, { p_request_token: body.requestToken, p_expected_revision: body.expectedRevision, p_event: body.event }); return { data: { status }, error: null, status: 200 }; } });
    const response = await route.POST(request('POST', body)); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, status }); assert.deepEqual(h.rpcRetries, [false]); assert.equal(h.requests.length, 0); assert.equal(h.logs.length, 0);
  }
});

test('callback rejects informal, ambiguous, invalid and expanded calendar events before service access', async () => {
  const patches = [{ body: 'private answer' }, { isCancelled: true }, { isAllDay: true }, { type: 'occurrence' }, { attendees: ['employee@example.test'] }, { attendees: ['ai@mobilityaccess.com.au', 'ai@mobilityaccess.com.au'] }, { organizer: 'Manager@example.test' }, { subject: 'Review without code' }, { subject: 'PR-2026-1 PR-2026-2' }, { start: '2026-10-22T11:00:00+11:00' }, { end: '2026-10-22T00:04:00Z' }, { start: '2026-10-22T00:00:00.000000001Z' }, { end: '2026-10-22T00:30:01Z' }, { modifiedAt: '2026-10-20T00:00:00Z' }, { mode: 'teams', location: 'https://foreign.example.test' }, { location: '' }, { id: 'event\nlog-injection' }, { start: '2026-04-04T15:30:00Z', end: '2026-04-04T16:00:00Z' }];
  const { h, route } = harness();
  for (const patch of patches) { const body = input(); Object.assign(body.event, patch); assert.equal((await route.POST(request('POST', body))).status, 400, JSON.stringify(patch)); }
  for (const body of [{ ...input(), actor: ids.review }, { ...input(), expectedRevision: 'self:1' }, { ...input(), requestToken: 'unknown' }, '{bad JSON', 'x'.repeat(32769)]) assert.equal((await route.POST(request('POST', body))).status, 400);
  for (const headers of [{ 'content-type': 'text/plain' }, { 'content-length': '32769' }, { 'content-length': '1' }]) assert.equal((await route.POST(request('POST', input(), { headers }))).status, 400);
  assert.equal((await route.POST(request('POST', input(), { query: '?readiness=1' }))).status, 400);
  assert.equal(h.clients, 0); assert.equal(h.logs.length, 0);
});

test('calendar metadata accepts canonical AI mailbox overlap and current approved Teams links', () => {
  const { rules } = harness();
  const body = input(); body.event.organizer = 'ai@mobilityaccess.com.au'; body.event.attendees = ['ai@mobilityaccess.com.au']; body.event.mode = 'teams'; body.event.location = 'https://teams.microsoft.com/l/meetup-join/synthetic';
  assert.deepEqual(rules.parseMeetingImportInput(body), body);
  const short = input(); short.event.end = '2026-10-22T00:05:00Z'; short.event.attendees.push('guest@example.test'); short.event.mode = 'teams'; short.event.location = 'https://teams.live.com/meet/synthetic';
  assert.deepEqual(rules.parseMeetingImportInput(short), short);
});

test('RPC errors, contradictory statuses and expanded receipts never leak event metadata', async () => {
  for (const result of [{ data: { status: 'imported' }, error: { message: 'private-calendar-details' }, status: 500 }, { data: { status: 'imported' }, error: null, status: 503 }, { data: { status: 'imported' }, error: undefined }, { data: { status: 'imported', event: input().event }, error: null }, { data: { status: 'updated' }, error: null }, { data: null, error: null }]) {
    const { h, route } = harness({ rpc: () => result });
    const response = await route.POST(request('POST', input())); assert.equal(response.status, 503); assert.equal(await response.text(), '{"ok":false,"code":"unavailable"}'); assert.equal(h.logs.length, 0);
  }
});

test('pending and callback deadlines terminate safely without transport or logs', async () => {
  for (const boundary of ['list', 'import', 'body']) {
    const { h, route } = harness({ timers: { setTimeout: (fn, delay) => setTimeout(fn, Math.min(delay, 20)) }, rpc: () => new Promise(() => {}) });
    const req = boundary === 'body' ? new Request(app + path, { method: 'POST', headers: { authorization: 'Bearer ' + cronSecret, 'content-type': 'application/json' }, body: new ReadableStream({ pull() { return new Promise(() => {}); } }), duplex: 'half' }) : request(boundary === 'list' ? 'GET' : 'POST', boundary === 'list' ? undefined : input());
    const response = await route[req.method](req); assert.equal(response.status, boundary === 'body' ? 400 : 503); assert.doesNotMatch(await response.text(), /synthetic|private|event|stack/i); assert.equal(h.logs.length, 0); assert.equal(h.requests.length, 0); if (boundary === 'body') assert.equal(h.clients, 0);
  }
});

test('live mode is rechecked across awaited list and body before exposing or importing metadata', async () => {
  let resolve;
  const listed = harness({ rpc: () => new Promise(r => { resolve = r; }) });
  const result = listed.route.GET(request()); await new Promise(setImmediate); listed.h.env.MAM_PERFORMANCE_REVIEW_ENABLED = 'false'; resolve({ data: [pending()], error: null }); assert.equal((await result).status, 503);
  let controller;
  const body = harness();
  const req = new Request(app + path, { method: 'POST', headers: { authorization: 'Bearer ' + cronSecret, 'content-type': 'application/json' }, body: new ReadableStream({ start(c) { controller = c; } }), duplex: 'half' });
  const posted = body.route.POST(req); await new Promise(setImmediate); body.h.env.PERFORMANCE_REVIEW_EMAIL_MODE = 'disabled'; controller.enqueue(new TextEncoder().encode(JSON.stringify(input()))); controller.close(); assert.equal((await posted).status, 503); assert.equal(body.h.clients, 0);
});

test('only the exact meeting endpoint bypasses cookie refresh and its own handler still authenticates', async () => {
  for (const configured of [true, false]) {
    const p = loadMailProxyHarness({ configured, env: env() });
    const response = await p.proxy(new NextRequest(request())); assert.equal(response.headers.get('x-middleware-next'), '1'); assert.deepEqual(p.counts, { configured: 0, config: 0, client: 0, claims: 0 });
    const route = p.h.load('src/app/api/performance-reviews/meeting/route.ts'); assert.equal((await route.GET(request('GET', undefined, { bearer: 'wrong' }))).status, 401); assert.equal(p.h.clients, 0);
    for (const suffix of ['/', '/extra', '-other']) { const blocked = await p.proxy(new NextRequest(request('GET', undefined, { suffix }))); assert.equal(blocked.status, 307); assert.match(new URL(blocked.headers.get('location')).pathname, /^\/login\/?$/); }
  }
});
