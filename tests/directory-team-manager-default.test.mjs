import assert from 'node:assert/strict';
import test from 'node:test';
import { draft, personId, loadActions } from './helpers/directory-action-harness.mjs';

const managerId = '10000000-0000-4000-8000-000000000002';
test('new employee validates the configured default before the atomic database create', async () => {
  const { actions, calls } = loadActions({ teamManagerDefault: { status: 'valid', managerId, managerName: 'Configured Synthetic' } });
  const result = await actions.createEmployeeDirectoryRecord(draft);
  assert.equal('error' in result, false);
  const resolutionIndex = calls.findIndex((call) => call.name === 'get_employee_team_manager_default');
  const creationIndex = calls.findIndex((call) => call.name.startsWith('create_employee_directory_record'));
  assert.ok(resolutionIndex >= 0 && resolutionIndex < creationIndex, 'Server Action must validate current default configuration before creation');
  assert.deepEqual(calls[resolutionIndex].args, { p_company_key: 'mam', p_team_name: 'Operation & Accounts' });
  assert.equal(calls[creationIndex].args.p_manager_id, null, 'Database must atomically resolve the default rather than receiving a stale preview ID');
});

test('missing configuration allows an unassigned create', async () => {
  const { actions, calls } = loadActions();
  const result = await actions.createEmployeeDirectoryRecord({ ...draft, workEmail: '' });
  assert.equal('error' in result, false);
  assert.equal(calls.find(call => call.name.startsWith('create_employee_directory_record')).args.p_manager_id, null);
  assert.equal(calls.some(call => call.name === 'account'), false);
});
test('invalid configuration rejects a default create before every mutation and account operation', async () => {
  const { actions, calls } = loadActions({ teamManagerDefault: { status: 'invalid', managerId: null, managerName: '' } });
  const result = await actions.createEmployeeDirectoryRecord(draft);
  assert.match(result.error, /configured Team Manager.*not available/);
  assert.equal(calls.some(call => call.name.startsWith('create_') || call.name === 'account'), false);
});
test('explicit active same-company override wins even when the configured default is invalid', async () => {
  const { actions, calls } = loadActions({ teamManagerDefault: { status: 'invalid', managerId: null, managerName: '' },
    managerRecord: { ...draft, personId: managerId, isActive: true, company: 'mam' } });
  const result = await actions.createEmployeeDirectoryRecord({ ...draft, workEmail: '', managerId });
  assert.equal('error' in result, false);
  assert.equal(calls.some(call => call.name === 'get_employee_team_manager_default'), false);
  assert.equal(calls.find(call => call.name.startsWith('create_employee_directory_record')).args.p_manager_id, managerId);
});
test('inactive and cross-company explicit overrides fail before creation', async () => {
  for (const manager of [{ isActive: false, company: 'mam' }, { isActive: true, company: 'equipsy' }]) {
    const { actions, calls } = loadActions({ managerRecord: { ...draft, personId: managerId, ...manager } });
    const result = await actions.createEmployeeDirectoryRecord({ ...draft, managerId });
    assert.match(result.error, /Choose a valid manager/);
    assert.equal(calls.some(call => call.name.startsWith('create_') || call.name === 'account'), false);
  }
});
test('malformed previews fail closed without adopting a missing configuration', async () => {
  for (const teamManagerDefault of [null, [], { status: 'valid', managerId: 'bad', managerName: 'Synthetic' },
    { status: 'valid', managerId, managerName: '' }, { status: 'missing', managerId, managerName: '' }, { status: 'unknown' }]) {
    const { actions, calls } = loadActions({ teamManagerDefault });
    const result = await actions.createEmployeeDirectoryRecord(draft);
    assert.match(result.error, /Team Manager could not be checked/);
    assert.equal(calls.some(call => call.name.startsWith('create_') || call.name === 'account'), false);
  }
});
test('preview authentication and input rejection returns sanitized serializable outcomes', async () => {
  const expired = loadActions({ authError: new Error('Your session has expired. Sign in again.') });
  assert.deepEqual(await expired.actions.getEmployeeTeamManagerDefault({ company: 'mam', teamName: 'Warehouse' }),
    { error: 'Your session has expired. Sign in again.' });
  assert.deepEqual(expired.calls, []);
  const denied = loadActions({ transportError: new Error('private synthetic provider detail') });
  assert.deepEqual(await denied.actions.getEmployeeTeamManagerDefault({ company: 'mam', teamName: 'Warehouse' }),
    { error: 'Team Manager could not be checked. Refresh and try again.' });
  const invalid = loadActions();
  for (const input of [null, { company: 'other', teamName: 'Warehouse' }, { company: 'mam', teamName: 'Unknown' }]) {
    const result = await invalid.actions.getEmployeeTeamManagerDefault(input);
    assert.equal(typeof result.error, 'string');
  }
  assert.deepEqual(invalid.calls, []);
});
test('ordinary edits preserve the authoritative manually changed parent instead of resolving any Team default', async () => {
  const manualManagerId = '10000000-0000-4000-8000-000000000003';
  const { actions, calls } = loadActions({ managerRecord: { ...draft, personId, managerId: manualManagerId } });
  const result = await actions.updateEmployeeDirectoryRecord({ ...draft, personId, managerId,
    teamName: 'Major', personVersion: 1, detailVersion: 1 });
  assert.equal('error' in result, false);
  assert.equal(calls.some(call => call.name === 'get_employee_team_manager_default' || call.name === 'account'), false);
  assert.equal(calls.find(call => call.name.startsWith('update_employee_directory_record')).args.p_manager_id, manualManagerId);
});
test('a default invalidated after preflight is rejected by the atomic create before any account operation', async () => {
  const { actions, calls } = loadActions({ teamManagerDefault: { status: 'valid', managerId, managerName: 'Configured Synthetic' },
    dbError: { code: '23503', message: 'Choose an active same-company employee as the manager.' } });
  assert.deepEqual(await actions.createEmployeeDirectoryRecord(draft), { error: 'Choose a valid manager and try again.' });
  assert.equal(calls.some(call => call.name === 'account' || call.name === 'revalidate'), false);
  assert.equal(calls.filter(call => call.name.startsWith('create_employee_directory_record')).length, 1);
});
