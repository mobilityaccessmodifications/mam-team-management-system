import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';

const require = createRequire(import.meta.url);

function loadSourceModule(file, sourceRoot, overrides, cache = new Map()) {
  if (cache.has(file)) return cache.get(file).exports;
  const mod = { exports: {} };
  cache.set(file, mod);
  const source = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', source)(id => {
    if (Object.hasOwn(overrides, id)) return overrides[id];
    if (id === 'server-only') return {};
    if (id.startsWith('@/')) return loadSourceModule(path.join(sourceRoot, 'src', id.slice(2) + '.ts'), sourceRoot, overrides, cache);
    return require(id);
  }, mod, mod.exports);
  return mod.exports;
}

export const archivePreflightInput = {
  personId: '10000000-0000-4000-8000-000000000001',
  personVersion: 1, detailVersion: 1, endDate: '2026-10-09', reason: 'Other',
};

export function archivePreflightFixture({ sourceRoot = process.cwd(), readError = false } = {}) {
  sourceRoot = path.resolve(sourceRoot);
  const state = { mutations: [], preflightReads: 0 };
  const forbidden = name => {
    state.mutations.push(name);
    throw new Error('Unexpected synthetic mutation: ' + name);
  };
  const admin = {
    from(table) {
      assert.equal(table, 'internal_org_people');
      let columns;
      const filters = [];
      const query = {
        select(value) { columns = value; return query; },
        eq(column, value) { filters.push([column, value]); return query; },
        async maybeSingle() {
          assert.equal(columns, 'auth_user_id,is_active');
          assert.deepEqual(filters, [['id', archivePreflightInput.personId], ['node_kind', 'person']]);
          return { data: { auth_user_id: '10000000-0000-4000-8000-000000000002', is_active: true }, error: null };
        },

      };
      return query;
    },
    rpc: async name => forbidden(name),
    auth: { admin: { updateUserById: async () => forbidden('Auth update') } },
  };
  const supabase = {
    auth: { getUser: async () => ({ data: { user: { id: '10000000-0000-4000-8000-000000000003' } }, error: null }) },
    async rpc(name, args) {
      if (name !== 'preflight_employee_removal_reporting_splice') return forbidden(name);
      assert.deepEqual(args, {
        p_person_id: archivePreflightInput.personId,
        p_expected_person_version: archivePreflightInput.personVersion,
        p_expected_detail_version: archivePreflightInput.detailVersion,
        p_end_date: archivePreflightInput.endDate,
        p_archive_reason: archivePreflightInput.reason,
      });
      state.preflightReads++;
      return {
        data: null,
        error: readError
          ? { message: 'private synthetic database details' }
          : { code: '55000', message: 'Onboarding credential delivery in progress' },
      };
    },
  };
  const actions = loadSourceModule(path.join(sourceRoot, 'src/app/people/actions.ts'), sourceRoot, {
    'next/cache': { revalidatePath() { forbidden('revalidation'); } },
    '@/lib/supabase/admin': { createAdminClient: () => admin },
    '@/lib/supabase/server': { createClient: async () => supabase },
    '@/app/accounts/actions': { createPortalAccount: async () => forbidden('account creation') },
    '@/lib/employee-directory': {
      requireEmployeeDirectoryManager: async () => ({ supabase, actorUserId: '10000000-0000-4000-8000-000000000003' }),
      findEmployeeDirectoryRecord: async () => forbidden('post-mutation directory read'),
    },
  });
  return { action: actions.archiveEmployeeDirectoryRecord, state };
}
