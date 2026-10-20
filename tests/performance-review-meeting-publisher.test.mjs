import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
test('workflow publication paginates bounded metadata, stages exact candidates and recovers unknown outcomes', () => {
  const result = spawnSync('/usr/bin/python3', ['-B', ROOT + 'tests/performance-review-meeting-publisher-fixture.py'], {cwd: ROOT, encoding: 'utf8', env: {PATH: '/usr/bin:/bin'}});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {ok: true, cases: 21, providerCalls: 0, realN8nCalls: 0});
});
test('publisher uses prescribed MAM verifier and bounded no-redirect readiness only, without business execution or secret argv', () => {
  const source = readFileSync(ROOT + 'scripts/publish-performance-review-meeting-workflows.py', 'utf8');
  assert.match(source, /subprocess\.run\(\['python3', 'scripts\/verify\.py'\], cwd=NROOT/);
  assert.match(source, /config\.get\('N8N_INSTANCE_LABEL'\) != 'MAM'/);
  assert.match(source, /origin != args\.expected_origin/);
  assert.match(source, /parser\.add_argument\('--expected-origin', required=True\)/);
  assert.match(source, /state\.get\('targetOrigin'\) != target_origin/);
  assert.match(source, /build_opener\(verifier\.NoRedirect\(\)\)/);
  assert.doesNotMatch(source, /workflows\?limit=100/);
  assert.ok(source.includes("'workflows?limit=20&excludePinnedData=true&name=' + quote(load_builder('calendar')['name'], safe='')"));
  assert.ok(source.includes("resource == listing or re.fullmatch(re.escape(listing) + r'&cursor=(?:[A-Za-z0-9_.~-]|%[0-9A-F]{2})+', resource)"));
  assert.match(source, /readiness_headers\(os\.environ\.get\('MAM_N8N_LEAVE_WEBHOOK_SECRET', ''\)\)/);
  assert.doesNotMatch(source, /MAM_PERFORMANCE_MEETING_CRON_SECRET|Authorization|Bearer/);
  assert.match(source, /return \{'X-MAM-Notification-Secret': secret\}/);
  assert.doesNotMatch(source, /add_argument\([^\n]*(?:secret|key|token)/);
  assert.doesNotMatch(source, /executeWorkflow|\/execute|\/run|POST.*webhook|sendMail/);
  assert.match(source, /return http\('GET', origin \+ READY_PATHS\[kind\], header\)/);
  assert.match(source, /e16479bf-d2c1-4b26-8457-3aa5b34a06e0/);
  assert.match(source, /d2668f6d7741ad80ff7f912ac16f2f96884babc254b3d2de6c990a3086a2c93f/);
});
