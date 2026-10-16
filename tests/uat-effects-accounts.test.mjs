import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTOR, fixture, ok, PASSWORD, PERSON, UNAVAILABLE, USER } from './uat-effects-fixtures.mjs';

const accountPath = 'src/app/accounts/actions.ts';
const directoryPath = 'src/app/people/actions.ts';
const accountInput = { personId: PERSON, userId: USER, loginName: 'synthetic@example.invalid', newPassword: PASSWORD, accountVersion: 1, enabled: false };
const draft = {
  firstName: 'Synthetic', lastName: 'Fixture', workEmail: '', personalEmail: '', phone: '',
  positionTitle: 'Tester', teamName: 'Operation & Accounts', managerId: null, country: '', address: '', dateOfBirth: '',
  startedDate: '2026-10-05', scheduledEmploymentEndDate: '', workingWeekdays: null, workingDayTimes: [],
  employmentType: 'full_time', contractType: '', laptopSupplied: '', laptopId: '', mouseId: '', keyboardId: '', assetTags: [],
  company: 'mam', isActive: true, personId: PERSON, personVersion: 1, detailVersion: 1,
};
const person = { id: PERSON, node_kind: 'person', company_key: 'mam', full_name: 'Synthetic Fixture', position_title: 'Tester', auth_user_id: USER, is_active: true, version: 1 };
const profile = { id: USER, login_name: 'synthetic@example.invalid', account_status: 'active', account_version: 1 };
const directoryRow = { person_id: PERSON, person_version: 1, detail_version: 1, company_key: 'mam', is_active: true, full_name: 'Synthetic Fixture', position_title: 'Tester' };

async function authorizedFixture(options = {}) {
  let f;
  let capabilities;
  const client = { auth: { getUser: async () => { f.calls.push('auth.getUser'); return ok({ user: { id: ACTOR } }); } }, rpc: async (name, args) => {
    f.calls.push('rpc:' + name);
    if (name === 'can_manage_portal_accounts' || name === 'can_manage_employee_directory') return ok(true);
    if (name === 'get_portal_role_capabilities') return ok([capabilities]);
    if (Object.hasOwn(options.rpc ?? {}, name)) return options.rpc[name](args);
    return f.hit('unexpected.rpc:' + name, args);
  } };
  f = fixture({ uat: options.uat ?? true, client, admin: options.admin, ports: options.ports });
  const role = await f.load('src/lib/portal-role-capabilities.ts');
  capabilities = { app_role: 'system_admin', person_id: null, account_status: 'active', ...Object.fromEntries(role.ROLE_CAPABILITY_FIELDS.map(key => [key, true])) };
  return f;
}

for (const name of ['createPortalAccount', 'updatePortalLogin', 'resetPortalPassword', 'togglePortalAccount']) {
  test(`UAT actual account mutation ${name} returns typed error before auth or admin`, async () => {
    const f = await authorizedFixture();
    try {
      const actions = await f.load(accountPath);
      let result;
      let thrown;
      try { result = await actions[name](accountInput); } catch (error) { thrown = error; }
      f.observe(name, { result, threw: Boolean(thrown) });
      f.assertZero(name);
      assert.equal(thrown, undefined);
      assert.deepEqual(result, { error: UNAVAILABLE });
      assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    } finally { f.cleanup(); }
  });
}

const mutations = [
  ['createEmployeeDirectoryRecord', draft, { error: UNAVAILABLE }],
  ['updateEmployeeDirectoryRecord', draft, { error: UNAVAILABLE }],
  ['updateEmployeeDirectoryRole', { personId: PERSON, role: 'manager', expectedRole: 'employee' }, { error: UNAVAILABLE }],
  ['archiveEmployeeDirectoryRecord', { ...draft, endDate: '2026-10-01', reason: 'Resigned' }, { ok: false, message: UNAVAILABLE }],
  ['deleteEmployeeDirectoryRecord', { personId: PERSON, personVersion: 1 }, { ok: false, message: UNAVAILABLE }],
];
for (const [name, input, expected] of mutations) {
  test(`UAT actual Directory mutation ${name} is serializable and inert`, async () => {
    const f = await authorizedFixture();
    try {
      const actions = await f.load(directoryPath);
      const result = await actions[name](input);
      f.observe(name, result);
      f.assertZero(name);
      assert.deepEqual(result, expected);
      assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    } finally { f.cleanup(); }
  });
}

function accountReadAdmin(f, lastSignIn = '2026-10-01T00:00:00Z') {
  return { from(table) {
    f.calls.push('read:' + table);
    const query = { select: () => query, eq: () => query, order: () => query, returns: async () => ok([person]), single: async () => ok(table === 'profiles' ? profile : person) };
    return query;
  }, auth: { admin: {
    listUsers: async () => { f.calls.push('provider.listUsers'); return ok({ users: [{ id: USER, last_sign_in_at: lastSignIn }] }); },
    getUserById: async () => { f.calls.push('provider.getUserById'); return ok({ user: { id: USER, last_sign_in_at: lastSignIn } }); },
  } } };
}

for (const uat of [true, false]) {
  test(`${uat ? 'UAT' : 'ordinary'} actual Accounts read keeps DB summaries${uat ? ' without target Auth admin reads' : ' and sign-in metadata'}`, async () => {
    const f = await authorizedFixture({ uat, rpc: { list_portal_account_summaries: () => ok([profile]) } });
    try {
      globalThis.__uatEffects.admin = () => { f.calls.push('admin'); return accountReadAdmin(f); };
      const actions = await f.load(accountPath);
      const result = await actions.listPortalAccounts();
      f.observe('listPortalAccounts ' + (uat ? 'UAT' : 'ordinary'), { count: result.length });
      assert.equal(result.length, 1);
      assert.equal(result[0].personId, PERSON);
      assert.equal(result[0].loginName, profile.login_name);
      assert.equal(result[0].status, 'active');
      assert.equal(f.calls.filter(name => name === 'provider.listUsers').length, uat ? 0 : 1);
      assert.equal(result[0].lastSignInAt, uat ? undefined : '2026-10-01T00:00:00Z');
      assert.deepEqual(f.calls.filter(name => name.startsWith('rpc:')), ['rpc:can_manage_portal_accounts', 'rpc:list_portal_account_summaries']);
    } finally { f.cleanup(); }
  });
}

test('ordinary login mutation preserves authorized RPC, account projection and target Auth read', async () => {
  const f = await authorizedFixture({ uat: false, rpc: { update_portal_login: () => ok([{ person_id: PERSON, auth_user_id: USER }]) }, ports: { revalidate: () => undefined } });
  try {
    globalThis.__uatEffects.admin = () => { f.calls.push('admin'); return accountReadAdmin(f); };
    const actions = await f.load(accountPath);
    const result = await actions.updatePortalLogin(accountInput);
    assert.equal(result.account.personId, PERSON);
    assert.equal(result.account.lastSignInAt, '2026-10-01T00:00:00Z');
    assert.deepEqual(f.calls.filter(name => name.startsWith('rpc:')), ['rpc:can_manage_portal_accounts', 'rpc:update_portal_login']);
    assert.equal(f.calls.filter(name => name === 'provider.getUserById').length, 1);
  } finally { f.cleanup(); }
});

test('UAT Directory reads and Team Manager default retain native getUser/RPC authorization', async () => {
  const f = await authorizedFixture({ rpc: {
    list_employee_directory_records_with_work_schedule_times: () => ok([directoryRow]),
    list_employee_check_in_contract_classifications: () => ok([]),
    get_employee_team_manager_default: () => ok({ status: 'missing', managerId: null, managerName: '' }),
  } });
  try {
    const actions = await f.load(directoryPath);
    const records = await actions.listEmployeeDirectoryRecords();
    assert.equal(records[0].personId, PERSON);
    assert.deepEqual(await actions.getEmployeeTeamManagerDefault({ company: 'mam', teamName: 'Operation & Accounts' }), { status: 'missing', managerId: null, managerName: '' });
    assert.equal(f.calls.filter(name => name === 'auth.getUser').length, 2);
    assert.equal(f.calls.includes('admin'), false);
    assert.equal(f.calls.some(name => name.startsWith('unexpected.')), false);
  } finally { f.cleanup(); }
});

test('ordinary Directory create retains validation, controlled write and committed record', async () => {
  const f = await authorizedFixture({ uat: false, rpc: {
    get_employee_team_manager_default: () => ok({ status: 'missing', managerId: null, managerName: '' }),
    create_employee_directory_record_with_work_schedule_times: () => ok([{ person_id: PERSON }]),
    get_employee_directory_record_with_work_schedule_times: () => ok([directoryRow]),
    list_employee_check_in_contract_classifications: () => ok([]),
  }, ports: { revalidate: () => undefined } });
  try {
    const actions = await f.load(directoryPath);
    assert.match((await actions.createEmployeeDirectoryRecord({ ...draft, startedDate: '' })).error, /start date is required/);
    assert.equal(f.calls.some(name => name.startsWith('rpc:create_')), false);
    const result = await actions.createEmployeeDirectoryRecord(draft);
    assert.equal(result.record.personId, PERSON);
    assert.match(result.warning, /without a portal account/);
    assert.equal(f.calls.filter(name => name === 'rpc:create_employee_directory_record_with_work_schedule_times').length, 1);
    assert.equal(f.calls.includes('admin'), false);
  } finally { f.cleanup(); }
});
