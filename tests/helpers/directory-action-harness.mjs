import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import path from 'node:path';
import { capabilities, loadModule } from './unified-role-harness.mjs';
import { loadUatSafety } from './uat-safety-loader.mjs';
const require = createRequire(import.meta.url);
export const personId = '10000000-0000-4000-8000-000000000001';
export const draft = {
  firstName: 'Taylor', lastName: 'Synthetic', workEmail: 'work@example.test', personalEmail: '', phone: '',
  positionTitle: 'Coordinator', teamName: 'Operation & Accounts', managerId: null, country: '', address: '', dateOfBirth: '',
  startedDate: '2026-10-05', scheduledEmploymentEndDate: '', workingWeekdays: null, workingDayTimes: [], archiveReason: '',
  employmentType: 'full_time', contractType: '', laptopSupplied: '', laptopId: '', mouseId: '', keyboardId: '', assetTags: [],
  company: 'mam', isActive: true,
};
export function loadActions({ dbError = null, authError = null, transportError = null, roleAccess = true, readErrorAt = 0, revalidateError = null, teamManagerError = null, teamManagerDefault = { status: 'missing', managerId: null, managerName: '' }, managerRecord = null, sourceRoot = process.cwd() } = {}) {
  const calls = [];
  let reads = 0;
  const team = { exports: {} };
  new Function('exports', ts.transpileModule(readFileSync(path.join(sourceRoot, 'src/lib/employee-teams.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(team.exports);
  const supabase = { auth: { getUser: async () => { if (authError) throw authError; return { data: { user: { id: personId } }, error: null }; } }, rpc: async (name, args) => {
    calls.push({ name, args });
    if (transportError) throw transportError;
    if (name === 'get_portal_role_capabilities') return { data: [capabilities(roleAccess ? 'system_admin' : 'admin', roleAccess ? null : personId)], error: null };
    if (name === 'can_manage_portal_accounts') return { data: roleAccess, error: null };
    if (name === 'get_employee_team_manager_default') return { data: teamManagerDefault, error: teamManagerError };
    return { data: name === 'update_employee_directory_role' ? args.p_role : [{ person_id: personId }], error: dbError };
  } };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', ts.transpileModule(readFileSync(path.join(sourceRoot, 'src/app/people/actions.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)((id) => ({
    '@/lib/uat-safety': loadUatSafety(process.env, sourceRoot),
    '@/lib/employee-teams': team.exports,
    '@/lib/portal-role-capabilities': loadModule(path.join(sourceRoot, 'src/lib/portal-role-capabilities.ts')),
    '@/lib/portal-role-access': loadModule(path.join(sourceRoot, 'src/lib/portal-role-access.ts'), { '@/lib/supabase/server': { createClient: async () => supabase }, '@/lib/portal-role-capabilities': loadModule(path.join(sourceRoot, 'src/lib/portal-role-capabilities.ts')) }),
    'next/cache': { revalidatePath: () => { calls.push({ name: 'revalidate' }); if (revalidateError) throw revalidateError; } },
    '@/lib/employee-directory': {
      requireEmployeeDirectoryManager: async () => { if (authError) throw authError; return { supabase }; },
      findEmployeeDirectoryRecord: async (_client, id) => { if (++reads === readErrorAt) throw new Error('private fixture read failure'); if (managerRecord?.personId === id) return managerRecord; return { ...draft, personId, personVersion: 2, detailVersion: 2, fullName: 'Taylor Synthetic' }; },
    },
    '@/app/accounts/actions': { createPortalAccount: async () => calls.push({ name: 'account' }) },
    '@/lib/organisation-directory': {}, '@/lib/supabase/admin': {}, '@/lib/portal-account-status': {},
  })[id] ?? require(id), mod, mod.exports);
  return { actions: mod.exports, calls };
}

