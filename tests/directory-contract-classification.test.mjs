import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { loadModule } from './helpers/unified-role-harness.mjs';

const require = createRequire(import.meta.url);
const teamModule = { exports: {} };
new Function('exports', ts.transpileModule(readFileSync('src/lib/employee-teams.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText)(teamModule.exports);

const personId = '10000000-0000-4000-8000-000000000001';
const managerId = '10000000-0000-4000-8000-000000000002';

function loadActions({ classificationError = null } = {}) {
  const calls = [];
  const supabase = { rpc: async (name, args) => {
    calls.push({ name, args });
    if (name === 'set_employee_check_in_contract_classification') {
      if (classificationError === 'throw') throw new Error('connection reset');
      return { data: null, error: classificationError };
    }
    return { data: [{ person_id: personId, person_version: 2, detail_version: 2 }], error: null };
  } };
  const source = ts.transpileModule(readFileSync('src/app/people/actions.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', source)((id) => ({
    '@/lib/employee-teams': teamModule.exports,
    '@/lib/portal-role-capabilities': loadModule('src/lib/portal-role-capabilities.ts'),
    '@/lib/portal-role-access': loadModule('src/lib/portal-role-access.ts', { '@/lib/supabase/server': { createClient: async () => supabase } }),
    'next/cache': { revalidatePath: () => {} },
    '@/lib/employee-directory': {
      requireEmployeeDirectoryManager: async () => ({ supabase }),
      findEmployeeDirectoryRecord: async (_client, id) => id === managerId
        ? { personId: managerId, company: 'mam', isActive: true }
        : { personId: id, contractType: '' },
      listEmployeeDirectoryRecordsForManager: async () => [],
    },
    '@/lib/organisation-directory': { getOrganisationPersonWorkEmailForMember: async () => null },
    '@/app/accounts/actions': { createPortalAccount: async () => ({}) },
    '@/lib/supabase/admin': { createAdminClient: () => ({}) },
    '@/lib/portal-account-status': {
      preparePortalAccountStatusChange: async () => ({}), finalisePortalAccountStatusChange: async () => ({}), recoverPortalAccountStatusChange: async () => ({}),
    },
  })[id] ?? require(id), mod, mod.exports);
  return { actions: mod.exports, calls };
}

const draft = {
  firstName: 'Taylor', lastName: 'Synthetic', workEmail: 'work@example.test', personalEmail: '', phone: '',
  positionTitle: 'Coordinator', teamName: 'Operation & Accounts', managerId, country: '', address: '', dateOfBirth: '',
  startedDate: '2026-10-05', scheduledEmploymentEndDate: '', workingWeekdays: null, workingDayTimes: [], archiveReason: '',
  employmentType: 'full_time', contractType: '', laptopSupplied: '', laptopId: '', mouseId: '', keyboardId: '', assetTags: [],
  company: 'mam', isActive: true,
};

test('Overseas employment passes through create and update server actions unchanged', async () => {
  const { actions, calls } = loadActions();
  await actions.createEmployeeDirectoryRecord({ ...draft, employmentType: 'overseas' });
  await actions.updateEmployeeDirectoryRecord({ ...draft, employmentType: 'overseas', personId, personVersion: 1, detailVersion: 1 });
  const writes = calls.filter((call) => /^(create|update)_employee_directory_record/.test(call.name));
  assert.equal(writes.length, 2);
  assert.ok(writes.every((call) => call.args.p_employment_type === 'overseas'));
});

test('creating an employee without a contract type makes no second write', async () => {
  const { actions, calls } = loadActions();
  const result = await actions.createEmployeeDirectoryRecord(draft);
  assert.deepEqual(result, { record: { personId, contractType: '' } });
  assert.ok(!calls.some((call) => call.name === 'set_employee_check_in_contract_classification'));
});

test('a failed contract-type write after create or update returns the saved record with a warning', async () => {
  for (const classificationError of [{ message: 'temporary outage' }, 'throw']) {
    const { actions, calls } = loadActions({ classificationError });
    const created = await actions.createEmployeeDirectoryRecord({ ...draft, contractType: 'permanent' });
    assert.equal(created.record.personId, personId);
    assert.match(created.warning, /contract type was not/);
    const updated = await actions.updateEmployeeDirectoryRecord({ ...draft, contractType: 'fixed_term', personId, personVersion: 1, detailVersion: 1 });
    assert.equal(updated.record.personId, personId);
    assert.match(updated.warning, /contract type was not/);
    assert.equal(calls.filter((call) => call.name === 'set_employee_check_in_contract_classification').length, 2);
  }
});

test('a successful contract-type write returns no warning', async () => {
  const { actions } = loadActions();
  const updated = await actions.updateEmployeeDirectoryRecord({ ...draft, contractType: 'permanent', personId, personVersion: 1, detailVersion: 1 });
  assert.deepEqual(updated, { record: { personId, contractType: '' } });
});
