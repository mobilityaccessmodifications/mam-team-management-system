import path from 'node:path';
import { loadModule } from './contact-lifetime-harness.mjs';
export const deliveryId = '71000000-0000-4000-8000-000000000001';
export const updatedAt = '2026-10-01T05:00:00.123456+00:00';
export const rowFixture = { delivery_id: deliveryId, employee_name: 'Synthetic Starter', company_key: 'mam', status: 'needs_review', review_code: 'delivery_uncertain', has_claimed_login: true, due_date: '2026-10-01', created_at: updatedAt, updated_at: updatedAt };
export function reviewActionHarness({ signedIn = true, permitted = true, authError = null, permissionError = null, dbError = null, cancelled = true, revalidateError = false, rows = [], transportError = null, sourceRoot = process.cwd() } = {}) {
  const calls = [], revalidations = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: signedIn ? { id: '71000000-0000-4000-8000-000000000002' } : null }, error: authError }) },
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === 'can_change_employee_view') return { data: permitted, error: permissionError };
      if (transportError) throw transportError;
      if (name === 'cancel_onboarding_credential_review') return { data: cancelled, error: dbError };
      if (name === 'list_onboarding_credential_reviews') return { data: rows, error: dbError };
      throw new Error('Unexpected boundary '+name);
    },
  };
  const actions = loadModule(path.join(sourceRoot, 'src/app/onboarding-review/actions.ts'), {
    '@/lib/supabase/server': { createClient: async () => client },
    'next/cache': { revalidatePath: route => { revalidations.push(route); if (revalidateError) throw new Error('synthetic cache failure'); } },
  });
  return { actions, calls, revalidations };
}
