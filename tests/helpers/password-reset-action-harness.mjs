import assert from 'node:assert/strict';
import { loadAccountActions } from '../account-actions-test-loader.mjs';

export const input = { personId: '95000000-0000-4000-8000-000000000002', userId: '95000000-0000-4000-8000-000000000002', accountVersion: 1, newPassword: 'Synthetic-Password-123!' };
export const lockMessage = 'The password was not changed. Onboarding credential delivery is in progress or awaiting administrator review.';
export function fixture(error = { code: '55000', message: 'Onboarding credential delivery in progress', details: 'private synthetic detail' }, authResult) {
  const calls = [];
  const ok = data => ({ data, error: null });
  const client = {
    auth: { getUser: async () => ok({ user: { id: '95000000-0000-4000-8000-000000000001' } }) },
    async rpc(name, args) {
      calls.push(name);
      if (name === 'can_manage_portal_accounts') return ok(true);
      if (name === 'cancel_portal_password_reset') return ok(true);
      if (name === 'finalise_portal_password_reset') return ok([{ person_id: input.personId, auth_user_id: input.userId, account_version: 2 }]);
      assert.equal(name, 'begin_portal_password_reset');
      assert.deepEqual(args, { p_person_id: input.personId, p_auth_user_id: input.userId, p_expected_account_version: input.accountVersion });
      return { data: error ? null : [{ person_id: input.personId, auth_user_id: input.userId, account_version: 1, reset_token: '95000000-0000-4000-8000-000000000003' }], error };
    },
  };
  const admin = {
    from(table) {
      const query = { select() { return query; }, eq() { return query; }, async single() {
        return ok(table === 'profiles'
          ? { id: input.userId, login_name: 'reset-staff@example.test', account_status: 'active', account_version: 1 }
          : { id: input.personId, auth_user_id: input.userId, node_kind: 'person', company_key: 'mam', full_name: 'Synthetic Starter', position_title: 'Tester', is_active: true, version: 1 });
      } };
      return query;
    },
    auth: { admin: {
      getUserById: async () => ok({ user: { id: input.userId } }),
      updateUserById: async () => {
        calls.push('auth-password-update');
        if (authResult instanceof Error) throw authResult;
        return authResult ?? ok({ user: { id: input.userId } });
      },
    } },
  };
  return { ...loadAccountActions(admin, client), calls };
}
