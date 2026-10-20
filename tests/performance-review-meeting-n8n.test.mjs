import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HUB = 'https://mam-team-management-system-ten.vercel.app/api/performance-reviews/meeting';
const OUTLOOK = {id: 'Ug5bTBjvF1vCSdhQ', name: 'Microsoft Outlook - ai@mobilityaccess.com.au'};
const CRON = {id: 'Fa0hGUfG9sTqnZXP', name: 'MAM People System - Check-In Reminder Cron Bearer v2'};
const build = () => {
  const p = spawnSync('/usr/bin/python3', ['-B', ROOT + 'scripts/build-performance-review-meeting-workflow.py'], {cwd: ROOT, encoding: 'utf8', env: {PATH: '/usr/bin:/bin'}});
  assert.equal(p.status, 0, p.stderr); return JSON.parse(p.stdout);
};
const workflow = build();
const node = name => workflow.nodes.find(n => n.name === name);
function run(name, value, {pending = request(), lookup = {}, now = 0} = {}) {
  const source = node(name).parameters.jsCode;
  const get = key => ({first: () => ({json: lookup[key]}), item: {json: {request: pending}}});
  return new Function('$json', '$input', '$', 'Date', source)(value, {all: () => [{json: value}]}, get, class extends Date {static now() {return now;}});
}
const request = (i = 1) => ({requestToken: '720f0200-0000-4000-8000-' + String(i).padStart(12, '0'),
  reviewId: '730f0200-0000-4000-8000-' + String(i).padStart(12, '0'), reviewCode: 'PR-2026-' + i,
  expectedRevision: 'manager:1:2', requestedAt: '2026-10-21T00:00:00.123456+00:00',
  managerEmail: 'manager@example.invalid', employeeEmail: 'employee@example.invalid'});
const event = (i = 1) => ({id: 'synthetic-event-' + i, iCalUId: 'synthetic-uid-' + i, subject: 'Re: Arrange performance review: PR-2026-' + i,
  type: 'singleInstance', isOrganizer: false, organizer: {emailAddress: {address: 'manager@example.invalid'}},
  attendees: ['ai@mobilityaccess.com.au', 'employee@example.invalid', 'careers@mobilityaccess.com.au'].map(address => ({emailAddress: {address}})),
  start: {dateTime: '2026-10-22T00:00:00.0000000', timeZone: 'UTC'}, end: {dateTime: '2026-10-22T00:30:00.0000000', timeZone: 'UTC'},
  isCancelled: false, isAllDay: false, isDraft: false, isOnlineMeeting: false, onlineMeeting: null, onlineMeetingProvider: 'unknown',
  location: {displayName: 'Synthetic meeting room'}, createdDateTime: '2026-10-21T01:00:00Z', lastModifiedDateTime: '2026-10-21T01:00:00Z', recurrence: null});
const response = value => ({statusCode: 200, body: {value}});
const queries = (requests, options) => run('Prepare Calendar Queries', {statusCode: 200, body: {ok: true, requests}}, options);
const parseEvent = (e, options) => run('Validate Manager Meeting', response([e]), options).json;

test('calendar graph uses only verified AI Graph GETs and protected pending/import API paths', () => {
  assert.equal(workflow.name, 'MAM People Hub - Performance Review Meeting Import (Live)');
  assert.equal(Object.hasOwn(workflow, 'active'), false);
  assert.deepEqual(workflow.settings, {executionOrder: 'v1', timezone: 'Australia/Melbourne', saveDataSuccessExecution: 'none',
    saveDataErrorExecution: 'none', saveManualExecutions: false, saveExecutionProgress: false, executionTimeout: 90});
  assert.equal(new Set(workflow.nodes.map(n => n.id)).size, workflow.nodes.length);
  for (const n of workflow.nodes) {
    assert.equal(n.retryOnFail, false);
    if (n.type === 'n8n-nodes-base.code') assert.doesNotMatch(n.parameters.jsCode, /\brequire\s*\(|\bfetch\s*\(|\$getWorkflowStaticData|console\./);
    if (n.type !== 'n8n-nodes-base.httpRequest') continue;
    const p = n.parameters;
    assert.equal(n.onError, 'continueRegularOutput'); assert.equal(p.options.redirect.redirect.followRedirects, false);
    assert.equal(p.options.response.response.fullResponse, true); assert.equal(p.options.response.response.neverError, true);
    assert.equal(p.options.response.response.responseFormat, 'json'); assert.equal(p.options.timeout, 5000);
    if (n.credentials.microsoftOutlookOAuth2Api) {
      assert.deepEqual(n.credentials.microsoftOutlookOAuth2Api, OUTLOOK); assert.equal(p.method, 'GET');
      assert.equal(p.nodeCredentialType, 'microsoftOutlookOAuth2Api'); assert.equal(p.authentication, 'predefinedCredentialType');
      assert.deepEqual(p.headerParameters.parameters, [{name: 'Prefer', value: 'IdType="ImmutableId", outlook.timezone="UTC"'}]);
      assert.ok(p.url.startsWith('https://graph.microsoft.com/v1.0/me?') || p.url.startsWith('https://graph.microsoft.com/v1.0/me/events?') || p.url === '={{ $json.queryUrl }}');
      assert.equal(Object.hasOwn(p, 'sendBody'), false); assert.doesNotMatch(p.url, /body|notes|attachments|sendMail/);
    } else {
      assert.deepEqual(n.credentials.httpHeaderAuth, CRON); assert.equal(p.authentication, 'genericCredentialType');
      assert.ok(p.url === HUB || p.url === HUB + '?readiness=1'); assert.equal(p.method, n.name === 'Import Meeting Once' ? 'POST' : 'GET');
    }
  }
  assert.deepEqual(node('Every Five Minutes').parameters.rule, {interval: [{field: 'minutes', minutesInterval: 5}]});
  assert.equal(node('Validate Manager Meeting').parameters.mode, 'runOnceForEachItem');
  assert.equal(node('Return Meeting Result').parameters.mode, 'runOnceForEachItem');
  assert.equal(node('Import Meeting Once').parameters.jsonBody, '={{ $json.importBody }}');
  const reachable = start => {
    const seen = new Set(), queue = [start]; while (queue.length) {const n = queue.shift(); if (seen.has(n)) continue; seen.add(n); queue.push(...(workflow.connections[n]?.main.flat() || []).map(v => v.node));} return seen;
  };
  assert.equal(reachable('Meeting Readiness').has('Import Meeting Once'), false);
  assert.equal(reachable('Every Five Minutes').has('Import Meeting Once'), true);
});

test('AI mailbox identity gate fails closed before pending or calendar processing', () => {
  for (const body of [{mail: 'ai@mobilityaccess.com.au', userPrincipalName: 'ai@mobilityaccess.com.au'}, {mail: null, userPrincipalName: 'AI@mobilityaccess.com.au'}]) {
    assert.equal(run('Verify AI Identity', {statusCode: 200, body})[0].json.valid, true);
  }
  for (const value of [{statusCode: 200, body: {}}, {statusCode: 200, body: {mail: 'other@example.invalid'}},
    {statusCode: 200, body: {mail: 'ai@mobilityaccess.com.au', userPrincipalName: 'other@example.invalid'}}, {statusCode: 503, body: {mail: 'ai@mobilityaccess.com.au'}}, {error: 'timeout'}]) {
    assert.equal(run('Verify AI Identity', value)[0].json.valid, false);
  }
  assert.deepEqual(workflow.connections['AI Identity Valid?'].main[0].map(v => v.node), ['Read Pending Meeting Imports']);
  assert.equal(workflow.connections['AI Identity Valid?'].main[1], undefined);
});

test('bounded fair batches eventually cover more than ten pending reviews without persistent state', () => {
  for (const size of [0, 1, 9, 10, 11, 25, 1000]) {
    const all = Array.from({length: size}, (_, i) => request(i + 1)).reverse(), seen = new Set();
    for (let tick = 0; tick < Math.ceil(size / 10) + 1; tick++) {
      const batch = queries(all, {now: tick * 300000}); assert.equal(batch.length, Math.min(size, 10));
      for (const v of batch) {
        seen.add(v.json.request.reviewId); assert.deepEqual(v.pairedItem, {item: 0});
        const u = new URL(v.json.queryUrl); assert.equal(u.origin + u.pathname, 'https://graph.microsoft.com/v1.0/me/events');
        const contains = code => "contains(subject,'" + code + "')";
        assert.equal(u.searchParams.get('$filter'), contains(v.json.request.reviewCode) + ' and not(' + Array.from({length: 10}, (_, digit) => contains(v.json.request.reviewCode + digit)).join(' or ') + ')');
        assert.equal(u.searchParams.get('$top'), '25'); assert.doesNotMatch(u.searchParams.get('$select'), /body|notes|attachments/);
      }
    }
    assert.equal(seen.size, size);
  }
});

test('query excludes longer numeric review codes before applying its bounded calendar result limit', () => {
  const u = new URL(queries([request()])[0].json.queryUrl), filter = u.searchParams.get('$filter');
  assert.ok(u.href.length < 2048);
  const contains = [...filter.matchAll(/contains\(subject,'([^']+)'\)/g)].map(match => match[1]);
  assert.deepEqual(contains, ['PR-2026-1', ...Array.from({length: 10}, (_, digit) => 'PR-2026-1' + digit)]);
  assert.equal(filter.replace(/contains\(subject,'[^']+'\)/g, 'TERM'), 'TERM and not(TERM or TERM or TERM or TERM or TERM or TERM or TERM or TERM or TERM or TERM)');
  const rows = [...Array.from({length: 100}, (_, i) => event(100 + i)), event()];
  const selected = rows.filter(row => row.subject.includes(contains[0]) && !contains.slice(1).some(code => row.subject.includes(code)));
  assert.equal(selected.length, 1); assert.equal(selected[0].id, event().id);
  assert.equal(run('Validate Manager Meeting', response(selected)).json.valid, true);
});

test('closed pending request metadata rejects malformed, private, duplicate and oversized responses', () => {
  const changes = [p => {p.answers = ['PRIVATE'];}, p => {p.requestToken = 'bad';}, p => {p.reviewId = 'bad';},
    p => {p.reviewCode = "PR-2026-1') or true";}, p => {p.expectedRevision = 'read:1:2';}, p => {p.requestedAt = '2026-02-30T00:00:00Z';},
    p => {p.managerEmail = 'Other@example.invalid';}, p => {p.employeeEmail = p.managerEmail;}];
  for (const change of changes) {const p = request(); change(p); assert.deepEqual(queries([p]), []);}
  assert.equal(queries([{...request(), employeeEmail: 'ai@mobilityaccess.com.au'}]).length, 1);
  assert.deepEqual(queries([request(), request()]), []); assert.deepEqual(queries(Array.from({length: 1001}, (_, i) => request(i + 1))), []);
  for (const value of [{statusCode: 503, body: {ok: true, requests: [request()]}}, {statusCode: 200, body: {ok: true, requests: [request()], extra: true}},
    {statusCode: 200, body: {ok: 'true', requests: [request()]}}, {error: 'timeout'}]) assert.deepEqual(run('Prepare Calendar Queries', value), []);
});

test('formal manager event imports only scheduling metadata and preserves pairing across requests', () => {
  for (const i of [1, 2, 99]) {
    const p = request(i), e = event(i); e.body = {content: 'PRIVATE EMPLOYEE ANSWERS'};
    const r = parseEvent(e, {pending: p}); assert.equal(r.valid, true);
    assert.deepEqual(r.importBody, {requestToken: p.requestToken, expectedRevision: p.expectedRevision, event: {
      id: e.id, uid: e.iCalUId, subject: e.subject, organizer: p.managerEmail,
      attendees: ['ai@mobilityaccess.com.au','careers@mobilityaccess.com.au','employee@example.invalid'],
      start: '2026-10-22T00:00:00Z', end: '2026-10-22T00:30:00Z', createdAt: '2026-10-21T01:00:00.000Z', modifiedAt: '2026-10-21T01:00:00.000Z',
      mode: 'in_person', location: 'Synthetic meeting room', isCancelled: false, isAllDay: false, type: 'singleInstance',
    }});
    assert.doesNotMatch(JSON.stringify(r.importBody), /PRIVATE|answers|notes|body/);
  }
  const own = event(); own.isOrganizer = true; own.organizer.emailAddress.address = 'ai@mobilityaccess.com.au';
  assert.equal(parseEvent(own, {pending: {...request(), managerEmail: 'ai@mobilityaccess.com.au'}}).valid, true);
  const e = event(); e.isOnlineMeeting = true; e.onlineMeetingProvider = 'teamsForBusiness'; e.onlineMeeting = {joinUrl: 'https://teams.microsoft.com/l/meetup-join/synthetic'};
  assert.equal(parseEvent(e).importBody.event.mode, 'teams'); assert.equal(parseEvent(e).importBody.event.location, e.onlineMeeting.joinUrl);
});

test('calendar and portal contract retain five minute meetings, guests, AI overlap and existing Teams hosts', () => {
  const five = event(); five.end.dateTime = '2026-10-22T00:05:00.0000000'; assert.equal(parseEvent(five).valid, true);
  const guest = event(); guest.attendees.push({emailAddress: {address: 'guest@example.invalid'}}); assert.equal(parseEvent(guest).valid, true);
  assert.equal(parseEvent(event(), {pending: {...request(), employeeEmail: 'ai@mobilityaccess.com.au'}}).valid, true);
  const past = event(); past.start.dateTime = '2026-10-20T00:00:00.0000000'; past.end.dateTime = '2026-10-20T00:05:00.0000000';
  assert.equal(parseEvent(past).valid, true);
  const live = event(); live.isOnlineMeeting = true; live.onlineMeetingProvider = 'teamsForBusiness'; live.onlineMeeting = {joinUrl: 'https://teams.live.com/meet/synthetic'};
  assert.equal(parseEvent(live).valid, true);
  const thirtyTwo = event(); thirtyTwo.attendees = ['ai@mobilityaccess.com.au','employee@example.invalid',...Array.from({length: 30}, (_, i) => 'guest' + i + '@example.invalid')].map(address => ({emailAddress: {address}}));
  assert.equal(parseEvent(thirtyTwo).valid, true);
  thirtyTwo.attendees.push({emailAddress: {address: 'excess@example.invalid'}}); assert.equal(parseEvent(thirtyTwo).valid, false);
});

test('untrusted calendar metadata cannot import unrelated, recurring, cancelled, ambiguous or unfinished invitations', () => {
  const changes = [
    e => {e.subject = 'PR-2026-10';}, e => {e.subject += ' PR-2026-2';}, e => {e.subject += ' PR-2026-1';}, e => {e.subject += '\r\nBcc: other@example.invalid';},
    e => {e.organizer.emailAddress.address = 'other@example.invalid';}, e => {e.attendees.pop(); e.attendees.pop();},
    e => {e.attendees.push({emailAddress: {address: 'invalid'}});}, e => {e.attendees.push(e.attendees[0]);},
    e => {e.recurrence = {};}, e => {e.type = 'seriesMaster';}, e => {e.isOrganizer = true;}, e => {e.isCancelled = true;}, e => {e.isAllDay = true;}, e => {e.isDraft = true;},
    e => {delete e.isDraft;}, e => {e.id = '';}, e => {e.iCalUId = 'x'.repeat(1025);},
    e => {e.start.timeZone = 'Australia/Melbourne';}, e => {e.start.dateTime = '2026-02-30T00:00:00';}, e => {e.start.dateTime = '2026-10-22T00:00:01';},
    e => {e.end.dateTime = '2026-10-22T00:04:00';}, e => {e.end.dateTime = '2026-10-23T00:00:00';},
    e => {e.createdDateTime = '2026-10-20T00:00:00Z';}, e => {e.lastModifiedDateTime = '2026-10-21T00:30:00Z';},
    e => {e.location.displayName = '';},
    e => {e.isOnlineMeeting = true; e.onlineMeetingProvider = 'teamsForBusiness'; e.onlineMeeting = {joinUrl: 'https://outside.example.invalid/join'};},
    e => {e.onlineMeeting = {joinUrl: 'https://teams.microsoft.com/l/synthetic'};},
  ];
  for (const change of changes) {const e = event(); change(e); assert.deepEqual(parseEvent(e), {valid: false}, change.toString());}
  for (const value of [response([]), response([event(), event()]), {statusCode: 200, body: {value: [event()], '@odata.nextLink': 'https://outside.example.invalid'}},
    {statusCode: 503, body: {value: [event()]}}, {error: 'timeout'}]) assert.deepEqual(run('Validate Manager Meeting', value).json, {valid: false});
  const near = event(); near.subject = 'PR-2026-10';
  assert.equal(run('Validate Manager Meeting', response([near, event()])).json.valid, true);
});

test('import acknowledgement distinguishes one committed import, duplicate receipt and manual edit skip', () => {
  for (const status of ['imported','already_imported','skipped']) {
    assert.deepEqual(run('Return Meeting Result', {statusCode: 200, body: {ok: true, status}}).json, {ok: true, status});
  }
  for (const value of [{statusCode: 200, body: {ok: true, status: 'imported', answers: 'PRIVATE'}}, {statusCode: 503, body: {ok: true, status: 'imported'}},
    {statusCode: 200, body: {ok: true, status: 'done'}}, {error: 'lost callback response'}]) {
    assert.deepEqual(run('Return Meeting Result', value).json, {ok: false, status: 'unavailable'});
  }
  assert.equal(workflow.connections['Return Meeting Result'], undefined);
  assert.deepEqual(queries([]), []);
});

test('readiness uses only no-DB readiness, AI identity and impossible subject metadata query', () => {
  const lookup = {'Check Meeting API Readiness': {statusCode: 200, body: {ok: true, ready: true}}, 'Verify Readiness AI Identity': {valid: true}};
  assert.deepEqual(run('Return Meeting Readiness', response([]), {lookup})[0].json, {ok: true, ready: true});
  for (const value of [response([event()]), {statusCode: 403, body: {}}, {error: 'unreachable'}]) {
    assert.deepEqual(run('Return Meeting Readiness', value, {lookup})[0].json, {ok: false, ready: false});
  }
  const u = new URL(node('Check Calendar Read Access').parameters.url);
  assert.equal(u.searchParams.get('$select'), 'id'); assert.match(u.searchParams.get('$filter'), /MAM-PEOPLE-HUB-READINESS/);
  assert.match(u.searchParams.get('$filter'), / and not\(contains/);
  assert.equal([...u.searchParams.get('$filter').matchAll(/contains\(/g)].length, 11);
  assert.equal(node('Meeting Readiness').parameters.httpMethod, 'GET'); assert.deepEqual(node('Meeting Readiness').credentials.httpHeaderAuth, CRON);
});
