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

const managerId = '10000000-0000-4000-8000-000000000002';
const personId = '10000000-0000-4000-8000-000000000001';
const draft = {
  firstName: 'Taylor', lastName: 'Synthetic', workEmail: 'work@example.test', personalEmail: '', phone: '',
  positionTitle: 'Coordinator', teamName: 'Operation & Accounts', managerId: null, country: '', address: '', dateOfBirth: '',
  startedDate: '2026-10-05', scheduledEmploymentEndDate: '', workingWeekdays: null, workingDayTimes: [],
  employmentType: 'full_time', contractType: '', laptopSupplied: '', laptopId: '', mouseId: '', keyboardId: '', assetTags: [],
  company: 'mam', isActive: true,
};

function loadActions() {
  const calls = [];
  const supabase = { rpc: async (name, args) => {
    calls.push({ name, args });
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
      findEmployeeDirectoryRecord: async () => ({ personId, managerId, personVersion: 2, detailVersion: 2 }),
      listEmployeeDirectoryRecordsForManager: async () => [],
    },
    '@/lib/organisation-directory': { getOrganisationPersonWorkEmailForMember: async () => null },
    '@/lib/supabase/admin': { createAdminClient: () => ({}) },
    '@/lib/portal-account-status': {
      preparePortalAccountStatusChange: async () => ({}), finalisePortalAccountStatusChange: async () => ({}), recoverPortalAccountStatusChange: async () => ({}),
    },
    '@/app/accounts/actions': { createPortalAccount: async () => ({}) },
  })[id] ?? require(id), mod, mod.exports);
  return { actions: mod.exports, calls };
}

test('active Directory create leaves reporting unassigned even if a caller supplies a manager', async () => {
  const { actions, calls } = loadActions();
  await actions.createEmployeeDirectoryRecord({ ...draft, managerId });
  const create = calls.find(({ name }) => name === 'create_employee_directory_record_with_work_schedule_times');
  assert.ok(create);
  assert.equal(create.args.p_manager_id, null);
});

test('Directory edit uses the current reporting link rather than a stale draft', async () => {
  const { actions, calls } = loadActions();
  await actions.updateEmployeeDirectoryRecord({ ...draft, personId, personVersion: 2, detailVersion: 2 });
  const update = calls.find(({ name }) => name === 'update_employee_directory_record_with_work_schedule_times');
  assert.ok(update);
  assert.equal(update.args.p_manager_id, managerId);
});

test('Directory create form does not offer a reporting picker', () => {
  const source = readFileSync('src/components/employee-directory.tsx', 'utf8');
  assert.doesNotMatch(source, /<EmployeePicker\b/);
  assert.doesNotMatch(source, /<label htmlFor=\{managerInputId\}>Reports to/);
});
