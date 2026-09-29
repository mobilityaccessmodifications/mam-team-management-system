import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const personId = '10000000-0000-4000-8000-000000000001';
function fixture({ startDate = '2020-01-01', workEmail = 'work@example.test', personalEmail = 'home@example.test', accountFails = false } = {}) {
  const calls = [];
  const created = { personId, personVersion: 1 };
  const client = { rpc: async (name) => {
    calls.push(name);
    if (name.startsWith('create_employee_directory_record')) return { data: [{ person_id: personId }], error: null };
    throw new Error(`Unexpected ${name}`);
  } };
  const account = async (input) => { calls.push(input); if (accountFails) throw new Error('synthetic failed'); return { oneTimePassword: 'Never-display-password' }; };
  const source = ts.transpileModule(readFileSync('src/app/people/actions.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  new Function('require','module','exports',source)((id) => ({
    'next/cache': { revalidatePath: () => {} },
    '@/lib/employee-teams': { requireEmployeeTeam: (value) => value },
    '@/lib/employee-directory': { requireEmployeeDirectoryManager: async () => ({ supabase: client }), findEmployeeDirectoryRecord: async () => created },
    '@/lib/organisation-directory': {},
    '@/lib/supabase/admin': {},
    '@/lib/portal-account-status': {},
    '@/app/accounts/actions': { createPortalAccount: account },
  })[id] ?? require(id), mod, mod.exports);
  const input = { firstName:'Synthetic',lastName:'Employee',workEmail,personalEmail,phone:'',positionTitle:'Tester',teamName:'MAM admin',managerId:personId,country:'',address:'',dateOfBirth:'',startedDate:startDate,scheduledEmploymentEndDate:'',workingWeekdays:null,workingDayTimes:[],archiveReason:'',employmentType:'full_time',laptopSupplied:'',laptopId:'',mouseId:'',keyboardId:'',assetTags:[],company:'mam',isActive:true };
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
test('account provisioning failure returns a saved employee with explicit warning rather than inviting a duplicate', async () => {
  const f = fixture({ accountFails: true });
  const result = await f.createEmployeeDirectoryRecord(f.input);
  assert.equal(result.record.personId, personId);
  assert.match(result.warning, /account.*review/i);
});
