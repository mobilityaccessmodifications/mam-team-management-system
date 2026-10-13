import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fixture, input, staleMessages, refreshMessage, accountNotice, verifyNoMutation } from './helpers/offboarding-version-conflict-harness.mjs';

const require = createRequire(import.meta.url);
const preflightGeneric = "The employee's reporting links could not be checked. Refresh and try again.";
const archiveGeneric = 'The employee profile could not be archived. Refresh and try again.';

for (const [index, message] of staleMessages.entries()) {
  test(`actual archive action maps PT409 stale ${index ? 'detail' : 'person'} before any claim/provider request`, async () => {
    const f = fixture({ preflightError: { code: 'PT409', message } });
    assert.deepEqual(await f.action(input), { ok: false, message: refreshMessage });
    verifyNoMutation(f.state);
    assert.equal(f.state.actorReads, 1);
    assert.deepEqual(f.state.calls.filter(x => x.name === 'preflight_employee_removal_reporting_splice').map(x => x.args), [{ p_person_id: input.personId, p_expected_person_version: 1, p_expected_detail_version: 1, p_end_date: input.endDate, p_archive_reason: input.reason }]);
  });
  test(`actual archive action maps PT409 stale ${index ? 'detail' : 'person'} after one acknowledged ban without compensation/retry`, async () => {
    const f = fixture({ archiveError: { code: 'PT409', message } });
    assert.deepEqual(await f.action(input), { ok: false, message: refreshMessage + accountNotice });
    assert.equal(f.state.providerReads, 0);
    assert.equal(f.state.providerUpdates, 1);
    assert.equal(f.state.provider, 'succeeded');
    assert.equal(f.state.claim, 'pending');
    assert.equal(f.state.banned, true);
    assert.equal(f.state.personActive, true);
    assert.equal(f.state.revalidations, 0);
    for (const name of ['preflight_employee_removal_reporting_splice', 'begin_portal_account_status_change', 'claim_portal_account_status_execution', 'record_portal_account_status_execution', 'archive_employee_directory_record']) assert.equal(f.state.calls.filter(x => x.name === name).length, 1, name);
    assert.equal(f.state.calls.filter(x => ['finalise_portal_account_status_change', 'cancel_portal_account_status_change'].includes(x.name)).length, 0);
  });
  for (const phase of ['preflight', 'archive']) test(`production Flight serializes actual ${phase} PT409 stale ${index ? 'detail' : 'person'} as safe data`, async () => {
    const options = { [phase + 'Error']: { code: 'PT409', message } };
    const script = `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      import { fixture, input, verifyNoMutation } from './tests/helpers/offboarding-version-conflict-harness.mjs';
      const require = createRequire(import.meta.url);
      const f = fixture(${JSON.stringify(options)});
      const result = f.action(input).then(r => {
        ${phase === 'preflight' ? 'verifyNoMutation(f.state);' : "assert.equal(f.state.providerUpdates, 1); assert.equal(f.state.claim, 'pending'); assert.equal(f.state.provider, 'succeeded'); assert.equal(f.state.banned, true);"}
        return r;
      });
      require('next/dist/compiled/react-server-dom-webpack/server.node').renderToPipeableStream({ result }, {}, { onError: () => 'synthetic-digest' }).pipe(process.stdout);
    `;
    const encoded = spawnSync(process.execPath, ['--conditions=react-server', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: 'C', LC_ALL: 'C', NODE_ENV: 'production' } });
    assert.equal(encoded.status, 0, encoded.stderr);
    const { createFromNodeStream } = require('next/dist/compiled/react-server-dom-webpack/cjs/react-server-dom-webpack-client.node.production.js');
    const model = await createFromNodeStream(Readable.from([encoded.stdout]), { moduleMap: {}, serverModuleMap: {}, moduleLoading: null });
    assert.deepEqual(await model.result, { ok: false, message: refreshMessage + (phase === 'archive' ? accountNotice : '') });
    assert.doesNotMatch(encoded.stdout, /synthetic-digest|:E\{|PT409|changed since it was opened|change_token|876000h/);
  });
}

for (const message of ['private synthetic account details', 'Role has changed. Refresh and try again.', staleMessages[0] + ' ', staleMessages[1].toLowerCase(), '', null]) {
  for (const phase of ['preflight', 'archive']) test(`unknown PT409 ${phase} message ${JSON.stringify(message)} stays sanitized`, async () => {
    const f = fixture({ [phase + 'Error']: { code: 'PT409', message } });
    assert.deepEqual(await f.action(input), { ok: false, message: (phase === 'preflight' ? preflightGeneric : archiveGeneric + accountNotice) });
    assert.equal(f.state.providerReads, 0);
    if (phase === 'preflight') verifyNoMutation(f.state);
    else assert.equal(f.state.providerUpdates, 1);
  });
}

for (const code of ['40001', 'pt409', 'PT4090', '', null]) test(`preflight code ${JSON.stringify(code)} retains exact finite mapping`, async () => {
  const f = fixture({ preflightError: { code, message: staleMessages[0] } });
  assert.deepEqual(await f.action(input), { ok: false, message: code === '40001' ? refreshMessage : preflightGeneric });
  verifyNoMutation(f.state);
});

for (const data of [false, null, 'true', [], [true], { allowed: true }]) test(`strict Boolean preflight retains rejection for ${JSON.stringify(data)}`, async () => {
  const f = fixture({ preflightData: data });
  assert.deepEqual(await f.action(input), { ok: false, message: preflightGeneric });
  verifyNoMutation(f.state);
});

for (const options of [{ allowed: false }, { session: false }, { self: true }]) test(`actor/self control retains rejection ${JSON.stringify(options)}`, async () => {
  const f = fixture(options);
  assert.equal((await f.action(input)).ok, false);
  verifyNoMutation(f.state);
  assert.equal(f.state.calls.filter(x => x.name === 'preflight_employee_removal_reporting_splice').length, 0);
});

for (const [error, expected] of [
  [{ code: '42501', message: 'private synthetic privilege details' }, "You do not have permission to reconnect this employee's reporting links."],
  [{ code: '55000', message: 'Onboarding credential delivery in progress' }, 'Reporting links are protected while onboarding credential delivery is in progress or awaiting administrator review.'],
]) test(`preflight ${error.code} negative control remains distinct`, async () => {
  const f = fixture({ preflightError: error });
  assert.deepEqual(await f.action(input), { ok: false, message: expected });
  verifyNoMutation(f.state);
});

test('authorized healthy path uses actual claim/provider/finalizer helpers once', async () => {
  const f = fixture();
  assert.deepEqual(await f.action(input), { ok: true, record: { personId: input.personId } });
  assert.equal(f.state.providerUpdates, 1);
  assert.equal(f.state.providerReads, 0);
  assert.equal(f.state.claim, 'finalised');
  assert.equal(f.state.revalidations, 1);
});

for (const error of [{ code: '40001', message: 'private synthetic' }, { code: 'PT409', message: 'Role has changed. Refresh and try again.' }, { code: 'PT409', message: staleMessages[0] }]) test(`role-only mapper retains separation ${JSON.stringify(error)}`, async () => {
  const f = fixture({ roleError: error });
  assert.deepEqual(await f.actions.updateEmployeeDirectoryRole({ personId: input.personId, role: 'employee', expectedRole: 'manager' }), { error: error.message === staleMessages[0] ? 'Role could not be saved. Refresh and try again.' : 'Role has changed. Refresh the directory and try again.' });
  verifyNoMutation(f.state);
});

test('source-root binding keeps every actual transitive module out of unrelated cwd', async () => {
  const sourceRoot = process.cwd();
  const unrelatedCwd = mkdtempSync(path.join(tmpdir(), 'mam-offboarding-version-source-'));
  try {
    process.chdir(unrelatedCwd);
    assert.notEqual(process.cwd(), sourceRoot);
    const f = fixture({ sourceRoot, preflightError: { code: 'PT409', message: staleMessages[0] } });
    assert.deepEqual(await f.action(input), { ok: false, message: refreshMessage });
    verifyNoMutation(f.state);
    const names = Object.keys(f.state.sources);
    assert.ok(names.length > 5);
    assert.ok(names.every(file => file.startsWith(sourceRoot + '/src/')));
    for (const file of ['src/app/people/actions.ts', 'src/lib/portal-account-status.ts', 'src/lib/employee-directory.ts', 'src/lib/portal-role-access.ts', 'src/lib/portal-role-capabilities.ts']) assert.ok(names.includes(sourceRoot + '/' + file), file);
  } finally {
    process.chdir(sourceRoot);
    rmSync(unrelatedCwd, { recursive: true, force: true });
  }
});
