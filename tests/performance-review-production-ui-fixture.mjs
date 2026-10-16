import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { actorId, personId, managerId, operationId, reviewId, meeting, review, mutation } from './performance-review-backend-fixtures.mjs';

const require = createRequire(import.meta.url);
const localImports = {
  '@/lib/performance-review-auth': 'src/lib/performance-review-auth.ts',
  '@/lib/performance-review-rules': 'src/lib/performance-review-rules.ts',
  '@/lib/portal-role-capabilities': 'src/lib/portal-role-capabilities.ts',
};
const packageImports = new Set(['@supabase/supabase-js', 'temporal-polyfill']);

export function finalReview() {
  return {
    ...review('manager'), selfStatus: 'manager_review', selfAnswers: Array(12).fill('Synthetic self evidence'),
    selfSubmittedAt: '2026-10-15T00:00:00Z', selfRevision: 'self:1',
    managerAnswers: Array(12).fill('Synthetic manager evidence'), ratings: Array(12).fill('2 Meets expectations'),
    summary: 'Synthetic summary', overallRating: '2 Meets expectations', managerNote: 'PRIVATE-SYNTHETIC-NOTE',
    managerCompletedAt: '2026-10-15T01:00:00Z', meeting: { ...meeting, date: '2026-10-15' },
    meetingHeldAt: '2026-10-15T01:30:00Z', finalisedAt: '2026-10-15T01:30:00Z', managerRevision: 'manager:1:3',
  };
}

export function finalInput() {
  return { ...mutation(), command: 'submit_review', expectedRevision: 'manager:1:2', input: { ...meeting, date: '2026-10-15', held: true } };
}

export function committedReceipt() {
  return { committed: true, operationId, review: finalReview() };
}

export function productionActionHarness({ role = 'manager', signedIn = true, accountStatus = 'active', canonicalData,
  canonicalError = null, canonicalStatus = 200, response = { data: committedReceipt(), error: null, status: 200 },
  rpcThrows = false, afterThrows = false, dispatchRejects = false, client: suppliedClient } = {}) {
  const calls = [], registrations = [], callbacks = [], dispatches = [], loaded = [];
  let authCalls = 0;
  const cache = new Map();
  const client = {
    auth: { getUser: async () => { authCalls++; return { data: { user: signedIn ? { id: actorId } : null }, error: null }; } },
    rpc: async (name, args) => {
      calls.push({ name, args: structuredClone(args) });
      if (name === 'get_portal_role_capabilities') {
        const { ROLE_CAPABILITY_FIELDS } = load('src/lib/portal-role-capabilities.ts');
        return { data: canonicalData === undefined ? [{ app_role: role, person_id: role === 'manager' ? managerId : personId,
          account_status: accountStatus, ...Object.fromEntries(ROLE_CAPABILITY_FIELDS.map(key => [key, false])) }] : canonicalData,
        error: canonicalError, status: canonicalStatus };
      }
      assert.ok(['mutate_performance_review', 'start_performance_review', 'performance_review_workspace',
        'get_performance_review_operation', 'get_performance_review_document'].includes(name), 'Unexpected offline RPC ' + name);
      if (rpcThrows) throw new Error('PRIVATE-SYNTHETIC-RPC');
      return typeof response === 'function' ? response(name, args) : response;
    },
  };
  const ports = {
    '@/lib/supabase/server': { createClient: async () => suppliedClient ?? client },
    'next/server': { after: callback => {
      assert.equal(typeof callback, 'function');
      registrations.push(callback);
      if (afterThrows) throw new Error('PRIVATE-SYNTHETIC-SCHEDULER');
      callbacks.push(callback);
    } },
    '@/lib/performance-review-mail': { dispatchPerformanceReviewMailForReview: async (...args) => {
      dispatches.push(args);
      if (dispatchRejects) throw new Error('PRIVATE-SYNTHETIC-MAIL');
    } },
  };
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const mod = { exports: {} };
    cache.set(file, mod);
    loaded.push(file);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    new Function('require', 'module', 'exports', code)(id => {
      if (Object.hasOwn(ports, id)) return ports[id];
      if (Object.hasOwn(localImports, id)) return load(localImports[id]);
      if (id === 'server-only') return {};
      if (packageImports.has(id)) return require(id);
      throw new Error('Unexpected closed Action import ' + id);
    }, mod, mod.exports);
    return mod.exports;
  }
  const actions = load('src/app/performance-reviews/actions.ts');
  assert.deepEqual(Object.keys(actions).sort(), ['getPerformanceReviewDocument', 'loadPerformanceReviews',
    'mutatePerformanceReview', 'reconcilePerformanceReviewOperation', 'startPerformanceReview'].sort());
  return { actions, calls, registrations, callbacks, dispatches, loaded, authCalls: () => authCalls,
    business: () => calls.filter(call => call.name !== 'get_portal_role_capabilities') };
}

export async function enabled(run, flag = 'true') {
  const previous = process.env.MAM_PERFORMANCE_REVIEW_ENABLED;
  if (flag === undefined) delete process.env.MAM_PERFORMANCE_REVIEW_ENABLED;
  else process.env.MAM_PERFORMANCE_REVIEW_ENABLED = flag;
  try { return await run(); }
  finally {
    if (previous === undefined) delete process.env.MAM_PERFORMANCE_REVIEW_ENABLED;
    else process.env.MAM_PERFORMANCE_REVIEW_ENABLED = previous;
  }
}

export { actorId, personId, managerId, operationId, reviewId, meeting, review, mutation };
