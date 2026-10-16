import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import { build, buildSync } from 'esbuild';

export const UAT_APP_ORIGIN = 'https://people-hub-uat.srv1866578.hstgr.cloud';
export const UAT_API_ORIGIN = 'https://supabase-uat.srv1866578.hstgr.cloud';
export const UAT_INSTANCE = 'mam-people-hub-uat-v1';

export function metadataOnlyTestKey(role) {
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ role, iss: UAT_INSTANCE, iat: 1700000000, exp: 4102444800 })).toString('base64url');
  return `${head}.${body}.${Buffer.from('synthetic-invalid-signature').toString('base64url')}`;
}

export function uatEnvironment() {
  return {
    MAM_APP_ENV: 'preview', MAM_UAT_ENABLED: 'true', NEXT_PUBLIC_MAM_UAT_ENABLED: 'true',
    MAM_UAT_TARGET: UAT_INSTANCE,
    NEXT_PUBLIC_APP_URL: UAT_APP_ORIGIN,
    NEXT_PUBLIC_SUPABASE_URL: UAT_API_ORIGIN,
    MAM_UAT_INTERNAL_SUPABASE_URL: 'http://uat-gateway:8080',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: metadataOnlyTestKey('anon'),
    SUPABASE_SECRET_KEY: metadataOnlyTestKey('service_role'),
    MAM_PERFORMANCE_REVIEW_ENABLED: 'true',
  };
}

export async function loadUatEntrypoint(relativePath, mocks = {}) {
  const path = fileURLToPath(new URL(`../${relativePath}`, import.meta.url));
  const result = await build({
    entryPoints: [path], bundle: true, platform: 'node', format: 'cjs', write: false,
    define: { 'import.meta.url': JSON.stringify(new URL(`../${relativePath}`, import.meta.url).href) },
    plugins: [{
      name: 'explicit-inert-uat-boundaries',
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'uat-fixture' } : null);
        build.onLoad({ filter: /.*/, namespace: 'uat-fixture' }, (args) => ({ contents: mocks[args.path], loader: 'js' }));
      },
    }],
  });
  const loaded = new Module(path);
  loaded.filename = path;
  loaded._compile(result.outputFiles[0].text, path);
  return loaded.exports;
}

export function loadUatSafety() {
  const path = fileURLToPath(new URL('../src/lib/uat-safety.ts', import.meta.url));
  assert.ok(existsSync(path), 'The actual Hub must contain its hosted UAT isolation guard');
  const result = buildSync({ entryPoints: [path], bundle: true, platform: 'node', format: 'cjs', write: false });
  const loaded = new Module(path);
  loaded.filename = path;
  loaded._compile(result.outputFiles[0].text, path);
  return loaded.exports;
}
