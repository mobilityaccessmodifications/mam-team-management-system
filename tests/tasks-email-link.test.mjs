import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAssetQrModule, loadAssetTestModule } from './asset-qr-test-loader.mjs';
import { capabilities, loadModule } from './helpers/unified-role-harness.mjs';
const qr = loadAssetQrModule();
for (const tab of ['tasks', 'performance']) {
const path = '/?view=people&tab=' + tab;
test(tab + ' mail links survive login while external and altered destinations are rejected', async () => {
  assert.equal(qr.assetLoginReturnPath(path), path);
  for (const value of ['https://example.test' + path, '//example.test' + path, path + '&next=https://example.test', path + '#other', '/?view=people&tab=directory', [path], null]) {
    assert.equal(qr.assetLoginReturnPath(value), null);
  }
  const { proxy } = loadAssetTestModule('src/proxy.ts', {
    '@/lib/asset-qr': qr,
    '@supabase/ssr': { createServerClient: () => ({ auth: { getClaims: async () => ({ data: { claims: null } }) } }) },
    'next/server': { NextResponse: { next: () => ({}), redirect: url => url } },
    '@/lib/supabase/config': { isSupabaseConfigured: () => true, requireSupabaseConfig: () => ({ supabaseUrl: 'https://example.test', supabasePublishableKey: 'synthetic' }) },
  });
  const url = new URL(path, 'https://example.test');
  const result = await proxy({ nextUrl: { pathname: url.pathname, search: url.search, clone: () => new URL(url) }, cookies: { getAll: () => [] } });
  assert.equal(result.pathname, '/login');
  assert.equal(result.searchParams.get('next'), path);
});
}
test('Home forwards the Tasks and Performance tabs through the authenticated navigation boundary', async () => {
  const actor = capabilities('employee');
  const { default: Home } = loadModule('src/app/page.tsx', {
    '@/components/leave-demo': { LeaveDemo: 'workspace' },
    '@/components/role-permission-recovery': { RolePermissionRecovery: 'recovery' },
    '@/lib/check-in-register': { getCheckInResourceLinks: () => ({}) },
    '@/lib/supabase/config': { isSupabaseConfigured: () => true },
    '@/lib/supabase/server': { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'synthetic-user' } } }) }, rpc: async name => ({ data: name === 'get_portal_role_capabilities' ? [actor] : false, error: null }) }) },
    'next/navigation': { redirect: () => { throw Error('unexpected redirect'); } },
  });
  for (const tab of ['tasks', 'performance']) {
    const rendered = await Home({ searchParams: Promise.resolve({ view: 'people', tab }) });
    assert.equal(rendered.props.initialNavigation.view, 'people');
    assert.equal(rendered.props.initialNavigation.peopleSection, tab);
  }
  const invalid = await Home({ searchParams: Promise.resolve({ view: 'people', tab: 'unrecognised' }) });
  assert.equal(invalid.props.initialNavigation.peopleSection, undefined);
});
