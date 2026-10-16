import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { loadModule } from './helpers/unified-role-harness.mjs';
import { loadUatSafety } from './helpers/uat-safety-loader.mjs';
const require = createRequire(import.meta.url);
const personId = '10000000-0000-4000-8000-000000000001';
function fixture({ startDate = '2020-01-01', workEmail = 'work@example.test', personalEmail = 'home@example.test', accountFails = false } = {}) {
  const calls = [];
  const created = { personId, personVersion: 1 };
  const client = { rpc: async (name) => {
    calls.push(name);
    if (name === 'get_employee_team_manager_default') return { data: { status: 'missing', managerId: null, managerName: '' }, error: null };
    if (name.startsWith('create_employee_directory_record')) return { data: [{ person_id: personId }], error: null };
    throw new Error(`Unexpected ${name}`);
  } };
  const account = async (input) => { calls.push(input); if (accountFails) throw new Error('synthetic failed'); return { oneTimePassword: 'Never-display-password' }; };
  const source = ts.transpileModule(readFileSync('src/app/people/actions.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  new Function('require','module','exports',source)((id) => ({
    '@/lib/uat-safety': loadUatSafety(),
    'next/cache': { revalidatePath: () => {} },
    '@/lib/portal-role-capabilities': loadModule('src/lib/portal-role-capabilities.ts'),
    '@/lib/portal-role-access': loadModule('src/lib/portal-role-access.ts', { '@/lib/supabase/server': { createClient: async () => client } }),
    '@/lib/employee-teams': { requireEmployeeTeam: (value) => value },
    '@/lib/employee-directory': { requireEmployeeDirectoryManager: async () => ({ supabase: client }), findEmployeeDirectoryRecord: async () => created },
    '@/lib/organisation-directory': {},
    '@/lib/supabase/admin': {},
    '@/lib/portal-account-status': {},
    '@/app/accounts/actions': { createPortalAccount: account },
  })[id] ?? require(id), mod, mod.exports);
  const input = { firstName:'Synthetic',lastName:'Employee',workEmail,personalEmail,phone:'',positionTitle:'Tester',teamName:'Operation & Accounts',managerId:null,country:'',address:'',dateOfBirth:'',startedDate:startDate,scheduledEmploymentEndDate:'',workingWeekdays:null,workingDayTimes:[],archiveReason:'',employmentType:'full_time',laptopSupplied:'',laptopId:'',mouseId:'',keyboardId:'',assetTags:[],company:'mam',isActive:true };
  return { ...mod.exports, input, calls };
}
test('creating employee provisions unprivileged login with work email and keeps password out of result', async () => {
  const f = fixture();
  const result = await f.createEmployeeDirectoryRecord(f.input);
  const account = f.calls.find((call) => typeof call === 'object');
  assert.equal(account.personId, personId);
  assert.equal(account.accountVersion, 1);
  assert.equal(account.loginName, 'work@example.test');
  assert.ok(typeof account.newPassword === "string" && account.newPassword.length >= 20);
  assert.ok(!JSON.stringify(result).includes(account.newPassword));
});
test('personal email is the login when no work email is present', async () => {
  const f = fixture({ workEmail: '' });
  await f.createEmployeeDirectoryRecord(f.input);
  assert.equal(f.calls.find((call) => typeof call === 'object').loginName, 'home@example.test');
});
test('active directory employee can be created without email and without a portal login', async () => {
  const f = fixture({ workEmail: '', personalEmail: '' });
  const result = await f.createEmployeeDirectoryRecord(f.input);
  assert.equal(result.record.personId, personId);
  assert.ok(f.calls.includes('create_employee_directory_record_with_work_schedule_times'));
  assert.ok(!f.calls.some((call) => typeof call === 'object'));
  assert.match(result.warning, /without a portal account/i);
});
test('account provisioning failure returns a saved employee with explicit warning rather than inviting a duplicate', async () => {
  const f = fixture({ accountFails: true });
  const result = await f.createEmployeeDirectoryRecord(f.input);
  assert.equal(result.record.personId, personId);
  assert.match(result.warning, /account.*review/i);
});
