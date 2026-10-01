import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import test from 'node:test';

const require = createRequire(import.meta.url);
import { draft, personId, loadActions } from './helpers/directory-action-harness.mjs';
const lockError = { code: '55000', message: 'Onboarding credential delivery in progress', details: 'private fixture detail', hint: 'private fixture hint' };
const lockMessage = 'This employee record is protected while onboarding credential delivery is in progress or awaiting administrator review. No changes were saved.';
const updateInput = { ...draft, personId, personVersion: 1, detailVersion: 1 };

if (process.env.MAM_FLIGHT_FIXTURE !== '1') test('locked Directory update returns an actionable safe failure without any follow-up writes', async () => {
  const { actions, calls } = loadActions({ dbError: lockError });
  assert.deepEqual(await actions.updateEmployeeDirectoryRecord(updateInput), { error: lockMessage });
  assert.equal(calls.length, 1);
  assert.match(calls[0].name, /^update_employee_directory_record/);
});

if (process.env.MAM_FLIGHT_FIXTURE === '1') {
  const { renderToPipeableStream } = require('next/dist/compiled/react-server-dom-webpack/server.node');
  const { actions } = loadActions({ dbError: lockError });
  renderToPipeableStream({
    a: actions.updateEmployeeDirectoryRecord(updateInput),
    create: actions.createEmployeeDirectoryRecord(draft),
    auth: loadActions({ authError: new Error('Your session has expired. Sign in again.') }).actions.updateEmployeeDirectoryRecord(updateInput),
    validation: loadActions().actions.createEmployeeDirectoryRecord({ ...draft, workEmail: 'invalid' }),
    unknown: loadActions({ dbError: { code: 'XX000', message: 'private fixture database detail' } }).actions.updateEmployeeDirectoryRecord(updateInput),
    role: loadActions({ dbError: { code: '40001' } }).actions.updateEmployeeDirectoryRole({ personId, role: 'manager', expectedRole: 'employee' }),
    partialCreate: loadActions({ readErrorAt: 1 }).actions.createEmployeeDirectoryRecord(draft),
    partialUpdate: loadActions({ readErrorAt: 2 }).actions.updateEmployeeDirectoryRecord(updateInput),
    partialRole: loadActions({ revalidateError: new Error('private fixture revalidation failure') }).actions.updateEmployeeDirectoryRole({ personId, role: 'manager', expectedRole: 'employee' }),
  }, {}, { onError: () => 'fixture-digest' }).pipe(process.stdout);
} else {
  test('a failed read after a committed save returns a safe refresh-only notice without inviting duplicate creation', async () => {
    for (const [method, readErrorAt] of [['createEmployeeDirectoryRecord', 1], ['updateEmployeeDirectoryRecord', 2]]) {
      const { actions, calls } = loadActions({ readErrorAt });
      assert.deepEqual(await actions[method](updateInput), { committed: true, personId, error: 'Employee details were saved, but the saved record could not be loaded. Refresh the directory before trying again. Do not create the employee again.' });
      assert.deepEqual(calls.map(call => call.name), method === 'createEmployeeDirectoryRecord'
        ? ['create_employee_directory_record_with_work_schedule_times']
        : ['update_employee_directory_record_with_work_schedule_times', 'set_employee_check_in_contract_classification']);
    }
  });
  test('known committed directory and role mutations retain their discriminator if revalidation fails', async () => {
    for (const method of ['createEmployeeDirectoryRecord', 'updateEmployeeDirectoryRecord', 'updateEmployeeDirectoryRole']) {
      const { actions, calls } = loadActions({ revalidateError: new Error('private fixture revalidation failure') });
      const input = method === 'updateEmployeeDirectoryRole' ? { personId, role: 'manager', expectedRole: 'employee' } : { ...updateInput, workEmail: '' };
      const result = await actions[method](input);
      assert.equal(result.committed, true);
      assert.equal(result.personId, personId);
      assert.match(result.error, /were saved|Role was saved/);
      assert.doesNotMatch(JSON.stringify(result), /private fixture/);
      assert.equal(calls.filter(call => /^(create|update)_employee_directory/.test(call.name)).length, 1);
      assert.ok(!calls.some(call => call.name === 'account'));
    }
  });
  test('create, update and role mutations return validation, access and unknown failures as sanitized data', async () => {
    const generic = 'Employee details could not be saved. Refresh and try again.';
    for (const method of ['createEmployeeDirectoryRecord', 'updateEmployeeDirectoryRecord', 'updateEmployeeDirectoryRole']) {
      const input = method === 'updateEmployeeDirectoryRole' ? { personId, role: 'manager', expectedRole: 'employee' } : updateInput;
      for (const message of ['Your session has expired. Sign in again.', 'You do not have permission to manage employee records.']) {
        const { actions, calls } = loadActions({ authError: new Error(message) });
        assert.deepEqual(await actions[method](input), { error: message });
        assert.equal(calls.length, 0);
      }
      const unauthorized = loadActions({ authError: new Error('private fixture token=synthetic-secret') });
      const unauthorizedResult = await unauthorized.actions[method](input);
      assert.equal(unauthorizedResult.error, method === 'updateEmployeeDirectoryRole' ? 'Role could not be saved. Refresh and try again.' : generic);
      assert.equal(unauthorized.calls.length, 0);
      const { actions } = loadActions({ transportError: new Error('private provider token=synthetic-secret') });
      const result = await actions[method](input);
      assert.equal(result.error, method === 'updateEmployeeDirectoryRole' ? 'Role could not be saved. Refresh and try again.' : generic);
      assert.doesNotMatch(JSON.stringify(result), /private|token|secret/);
    }
    for (const method of ['createEmployeeDirectoryRecord', 'updateEmployeeDirectoryRecord']) {
      const { actions, calls } = loadActions();
      assert.deepEqual(await actions[method]({ ...updateInput, workEmail: 'invalid' }), { error: 'Enter a valid work email.' });
      assert.deepEqual(await actions[method]({ ...updateInput, teamName: 'private injected team' }), { error: 'Choose a team from the list.' });
      assert.equal(calls.length, 0);
      const locked = loadActions({ dbError: lockError });
      assert.deepEqual(await locked.actions[method](updateInput), { error: lockMessage });
      assert.equal(locked.calls.length, 1);
      const denied = loadActions({ dbError: { code: '40001', message: 'private version detail' } });
      assert.deepEqual(await denied.actions[method](updateInput), { error: 'This record has changed. Refresh it, then try again.' });
      const unknown = loadActions({ dbError: { code: 'XX000', message: 'private manager provider detail', details: 'synthetic-secret' } });
      assert.deepEqual(await unknown.actions[method](updateInput), { error: generic });
      assert.equal(unknown.calls.length, 1);
    }
    const roleDenied = loadActions({ roleAccess: false });
    assert.deepEqual(await roleDenied.actions.updateEmployeeDirectoryRole({ personId, role: 'manager', expectedRole: 'employee' }), { error: 'Only a System Admin can change roles.' });
    assert.deepEqual(roleDenied.calls.map(call => call.name), ['can_manage_portal_accounts']);
    const role = loadActions({ dbError: { code: '40001', message: 'private role detail' } });
    assert.deepEqual(await role.actions.updateEmployeeDirectoryRole({ personId, role: 'manager', expectedRole: 'employee' }), { error: 'Role has changed. Refresh the directory and try again.' });
    assert.deepEqual(await role.actions.updateEmployeeDirectoryRole({ personId, role: 'invalid', expectedRole: 'employee' }), { error: 'Choose a valid role and refresh the employee record.' });
  });
  test('production Flight Server Action result transports the reason as data, not a redacted RSC exception', async () => {
    const encoded = spawnSync(process.execPath, ['--conditions=react-server', '--input-type=module', '-e', `await import('./tests/directory-safe-errors.test.mjs')`], {
      encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production', MAM_FLIGHT_FIXTURE: '1' },
    });
    assert.equal(encoded.status, 0, encoded.stderr);
    const { createFromNodeStream } = require('next/dist/compiled/react-server-dom-webpack/cjs/react-server-dom-webpack-client.node.production.js');
    const result = await createFromNodeStream(Readable.from([encoded.stdout]), { moduleMap: {}, serverModuleMap: {}, moduleLoading: null });
    assert.deepEqual(await result.a, { error: lockMessage });
    assert.deepEqual(await result.create, { error: lockMessage });
    assert.deepEqual(await result.auth, { error: 'Your session has expired. Sign in again.' });
    assert.deepEqual(await result.validation, { error: 'Enter a valid work email.' });
    assert.deepEqual(await result.unknown, { error: 'Employee details could not be saved. Refresh and try again.' });
    assert.deepEqual(await result.role, { error: 'Role has changed. Refresh the directory and try again.' });
    for (const key of ['partialCreate', 'partialUpdate', 'partialRole']) {
      const partial = await result[key];
      assert.equal(partial.committed, true);
      assert.equal(partial.personId, personId);
      assert.match(partial.error, /were saved|Role was saved/);
    }
    assert.doesNotMatch(encoded.stdout, /private fixture|fixture-digest|:E\{/);
  });
}
