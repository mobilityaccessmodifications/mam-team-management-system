import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAssetQrModule, loadAssetTestModule } from './asset-qr-test-loader.mjs';
const qr = loadAssetQrModule();
const path = '/?view=people&tab=tasks';
test('Tasks mail links survive login while external and altered destinations are rejected', async () => {
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
test('Home forwards the Tasks tab through the authenticated navigation boundary', async () => {
  const { default: Home } = loadAssetTestModule('src/app/page.tsx', {
    '@/components/leave-demo': { LeaveDemo: 'workspace' },
    '@/components/role-permission-recovery': { RolePermissionRecovery: 'recovery' },
    '@/app/roles/actions': { getPortalRoleCapabilities: async () => ({ ok: true, capabilities: { person_id: 'synthetic-person' } }) },
    '@/lib/check-in-register': { getCheckInResourceLinks: () => ({}) },
    '@/lib/supabase/config': { isSupabaseConfigured: () => true },
    '@/lib/supabase/server': { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'synthetic-user' } } }) }, rpc: async () => ({ data: false }) }) },
    'next/navigation': { redirect: () => { throw Error('unexpected redirect'); } },
  });
  const rendered = await Home({ searchParams: Promise.resolve({ view: 'people', tab: 'tasks' }) });
  assert.equal(rendered.props.initialNavigation.view, 'people');
  assert.equal(rendered.props.initialNavigation.peopleSection, 'tasks');
  const invalid = await Home({ searchParams: Promise.resolve({ view: 'people', tab: 'unrecognised' }) });
  assert.equal(invalid.props.initialNavigation.peopleSection, undefined);
});
