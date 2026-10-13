import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { capabilities } from './unified-role-harness.mjs';

const require = createRequire(import.meta.url);
export const staleMessages = [
  'This employee changed since it was opened. Refresh and try again.',
  'This employee detail changed since it was opened. Refresh and try again.',
];
export const refreshMessage = 'This record has changed. Refresh it, then try again.';
export const accountNotice = ' The portal account remains disabled with a pending claim; retry the archive after resolving this issue.';
export const input = { personId: 'a7400000-0000-4000-8000-000000000001', personVersion: 1, detailVersion: 1, endDate: '2026-10-09', reason: 'Other' };
const userId = 'a7400000-0000-4000-8000-000000000002';
const actorId = 'a7400000-0000-4000-8000-000000000003';
const token = 'a7400000-0000-4000-8000-000000000004';

export function fixture({ sourceRoot = process.cwd(), preflightError = null, archiveError = null, preflightData = true, allowed = true, session = true, self = false, roleError = null } = {}) {
  sourceRoot = path.resolve(sourceRoot);
  const state = { calls: [], providerReads: 0, providerUpdates: 0, actorReads: 0, claim: null, provider: 'not_started', banned: false, personActive: true, revalidations: 0, sources: {} };
  const cache = new Map();
  function load(relative, overrides) {
    const file = path.join(sourceRoot, relative);
    if (cache.has(file)) return cache.get(file).exports;
    const mod = { exports: {} };
    cache.set(file, mod);
    const raw = readFileSync(file);
    state.sources[file] = createHash('sha256').update(raw).digest('hex');
    const source = ts.transpileModule(raw.toString('utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    new Function('require', 'module', 'exports', source)(id => {
      if (Object.hasOwn(overrides, id)) return overrides[id];
      if (id === 'server-only') return {};
      if (id.startsWith('@/')) return load('src/' + id.slice(2) + '.ts', overrides);
      return require(id);
    }, mod, mod.exports);
    return mod.exports;
  }
  const admin = {
    from(table) {
      const filters = [];
      let columns;
      const query = {
        select(value) { columns = value; return query; },
        eq(key, value) { filters.push([key, value]); return query; },
        async maybeSingle() {
          state.calls.push({ name: 'admin:' + table, columns, filters });
          if (table === 'internal_org_people') return { data: { auth_user_id: self ? actorId : userId, is_active: state.personActive }, error: null };
          assert.equal(table, 'profiles');
          return { data: { account_status: 'active', account_version: 1 }, error: null };
        },
      };
      return query;
    },
    auth: { admin: {
      async getUserById() { state.providerReads++; throw new Error('Unexpected target provider read'); },
      async updateUserById(id, args) {
        assert.equal(id, userId);
        assert.deepEqual(args, { ban_duration: '876000h' });
        state.providerUpdates++;
        state.banned = true;
        return { data: { user: { id } }, error: null };
      },
    } },
    async rpc(name, args) {
      state.calls.push({ name, args });
      if (name === 'claim_portal_account_status_execution') {
        if (state.provider === 'succeeded') return { data: 'succeeded', error: null };
        state.provider = 'executing';
        return { data: 'execute', error: null };
      }
      assert.equal(name, 'record_portal_account_status_execution');
      assert.equal(args.p_succeeded, true);
      state.provider = 'succeeded';
      return { data: true, error: null };
    },
  };
  const client = {
    auth: { async getUser() { state.actorReads++; return { data: { user: session ? { id: actorId } : null }, error: null }; } },
    async rpc(name, args) {
      state.calls.push({ name, args });
      if (name === 'can_manage_employee_directory') return { data: allowed, error: null };
      if (name === 'get_portal_role_capabilities') return { data: [capabilities('system_admin', null)], error: null };
      if (name === 'update_employee_directory_role') return { data: null, error: roleError };
      if (name === 'preflight_employee_removal_reporting_splice') return { data: preflightError ? null : preflightData, error: preflightError };
      if (name === 'begin_portal_account_status_change') {
        state.claim = 'pending';
        return { data: [{ change_token: token, account_status: 'active', account_version: 1 }], error: null };
      }
      if (name === 'archive_employee_directory_record') {
        if (archiveError) return { data: null, error: archiveError };
        state.personActive = false;
        return { data: [{ person_id: input.personId }], error: null };
      }
      assert.equal(name, 'finalise_portal_account_status_change');
      state.claim = 'finalised';
      return { data: [{ person_id: input.personId, auth_user_id: userId }], error: null };
    },
  };
  const overrides = {
    'next/cache': { revalidatePath() { state.revalidations++; } },
    '@/lib/supabase/server': { createClient: async () => client },
    '@/lib/supabase/admin': { createAdminClient: () => admin },
    '@/app/accounts/actions': { createPortalAccount: async () => { throw new Error('Unexpected account creation'); } },
  };
  overrides['@/lib/employee-directory'] = { ...load('src/lib/employee-directory.ts', overrides), findEmployeeDirectoryRecord: async () => ({ personId: input.personId }) };
  const actions = load('src/app/people/actions.ts', overrides);
  assert.equal(typeof actions.archiveEmployeeDirectoryRecord, 'function');
  return { actions, action: actions.archiveEmployeeDirectoryRecord, state };
}

export function verifyNoMutation(state) {
  assert.equal(state.providerReads, 0);
  assert.equal(state.providerUpdates, 0);
  assert.equal(state.claim, null);
  assert.equal(state.banned, false);
  assert.equal(state.personActive, true);
  assert.equal(state.revalidations, 0);
  assert.equal(state.calls.filter(x => ['begin_portal_account_status_change', 'claim_portal_account_status_execution', 'record_portal_account_status_execution', 'archive_employee_directory_record', 'finalise_portal_account_status_change'].includes(x.name)).length, 0);
}
