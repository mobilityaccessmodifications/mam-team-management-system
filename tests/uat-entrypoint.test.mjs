import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadUatEntrypoint, uatEnvironment, UAT_APP_ORIGIN } from './uat-fixtures.mjs';

function withUatEnvironment(run) {
  const changes = uatEnvironment();
  const original = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  Object.assign(process.env, changes);
  return Promise.resolve().then(run).finally(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function apiPaths() {
  const base = fileURLToPath(new URL('../src/app/api', import.meta.url));
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(name);
      else if (entry.name === 'route.ts') found.push('/api/' + path.relative(base, dir).split(path.sep).join('/'));
    }
  };
  walk(base);
  return found.sort();
}

test('actual proxy refuses every UAT API before native auth, cookies or handler dispatch', async () => {
  const counts = { clients: 0, cookies: 0 };
  globalThis.__mamUatProxyCounts = counts;
  const mocks = {
    '@supabase/ssr': `export function createServerClient() { globalThis.__mamUatProxyCounts.clients++; return {auth:{getClaims:async()=>({data:{claims:null}})}}; }`,
    'next/server': `export const NextResponse = {next:()=>new Response(null,{status:200}),json:(data,init)=>Response.json(data,init),redirect:(url)=>new Response(null,{status:307,headers:{location:String(url)}})};`,
  };
  try {
    await withUatEnvironment(async () => {
      const { proxy } = await loadUatEntrypoint('src/proxy.ts', mocks);
      const paths = ['/api', '/api/cron/recovery', ...apiPaths(), '/api/new-unreviewed-route', '/auth/confirm'];
      assert.ok(apiPaths().length > 0);
      for (const pathname of paths) {
        const nextUrl = new URL(UAT_APP_ORIGIN + pathname);
        nextUrl.clone = () => new URL(nextUrl);
        const result = await proxy({ nextUrl, cookies: { getAll() { counts.cookies++; return []; } } });
        assert.equal(result.status, 403, pathname);
      }
      assert.deepEqual(counts, { clients: 0, cookies: 0 });
    });
    const { proxy } = await loadUatEntrypoint('src/proxy.ts', mocks);
    const ordinary = await proxy({ nextUrl: new URL('https://mam-team-management-system-ten.vercel.app/api/cron/recovery') });
    assert.equal(ordinary.status, 200, 'ordinary production bypass behavior is unchanged');
  } finally {
    delete globalThis.__mamUatProxyCounts;
  }
});

test('actual browser and server config rejects a production target before SDK construction', async () => {
  await withUatEnvironment(async () => {
    const good = await loadUatEntrypoint('src/lib/supabase/config.ts');
    assert.equal(good.isSupabaseConfigured(), true);
    for (const url of ['https://xtwlrjqbusadghavchqm.supabase.co', 'https://kywdmxpmlualztgwfokg.supabase.co']) {
      process.env.NEXT_PUBLIC_SUPABASE_URL = url;
      const unsafe = await loadUatEntrypoint('src/lib/supabase/config.ts');
      assert.throws(() => unsafe.requireSupabaseConfig(), /UAT/);
      assert.throws(() => unsafe.isSupabaseConfigured(), /UAT/);
    }
  });
});

test('native SSR, admin and proxy keep public cookie identity while using the private UAT transport', async () => {
  const originalFetch = globalThis.fetch;
  const observed = [];
  const requests = [];
  globalThis.__mamUatSdkObserved = observed;
  globalThis.fetch = async (input, init) => {
    requests.push(new Request(input, init).url);
    return Response.json({});
  };
  const factory = `export function createServerClient(url,key,options) { globalThis.__mamUatSdkObserved.push({url,options}); return {url,options,auth:{getClaims:async()=>{if(options.global?.fetch) await options.global.fetch(url+'/auth/v1/user'); return {data:{claims:null}};}}}; }`;
  const mocks = {
    'server-only': '',
    '@supabase/ssr': factory,
    '@supabase/supabase-js': `export function createClient(url,key,options) { globalThis.__mamUatSdkObserved.push({url,options}); return {url,options}; }`,
    'next/headers': `export async function cookies(){return {getAll:()=>[],set:()=>{}};}`,
    'next/server': `export const NextResponse = {next:()=>new Response(null,{status:200}),json:(data,init)=>Response.json(data,init),redirect:(url)=>new Response(null,{status:307,headers:{location:String(url)}})};`,
  };
  try {
    await withUatEnvironment(async () => {
      const server = await loadUatEntrypoint('src/lib/supabase/server.ts', mocks);
      const client = await server.createClient();
      assert.equal(client.url, uatEnvironment().NEXT_PUBLIC_SUPABASE_URL);
      assert.equal(typeof client.options.global?.fetch, 'function');
      await client.options.global.fetch(client.url + '/auth/v1/user');
      const admin = await loadUatEntrypoint('src/lib/supabase/admin.ts', mocks);
      const service = admin.createAdminClient();
      assert.equal(service.url, client.url);
      assert.equal(typeof service.options.global?.fetch, 'function');
      await service.options.global.fetch(service.url + '/rest/v1/rpc/claim_portal_login_attempt', { method: 'POST', body: '{}' });
      const { proxy } = await loadUatEntrypoint('src/proxy.ts', mocks);
      const result = await proxy({ nextUrl: new URL(UAT_APP_ORIGIN + '/login'), cookies: { getAll: () => [] } });
      assert.equal(result.status, 200);
      assert.equal(observed.length, 3);
      assert.ok(observed.every((entry) => entry.url === client.url));
      assert.ok(observed.every((entry) => typeof entry.options.global?.fetch === 'function'));
      assert.equal(requests.length, 3);
      assert.ok(requests.every((url) => url.startsWith('http://uat-gateway:8080/')));
    });
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.__mamUatSdkObserved;
  }
});

test('actual Next config rejects unsafe UAT builds and emits isolated browser policy', async () => {
  await withUatEnvironment(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://xtwlrjqbusadghavchqm.supabase.co';
    await assert.rejects(() => loadUatEntrypoint('next.config.ts'), /UAT/);
    process.env.NEXT_PUBLIC_SUPABASE_URL = uatEnvironment().NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    const { default: config } = await loadUatEntrypoint('next.config.ts');
    assert.equal(config.output, 'standalone');
    const headers = (await config.headers())[0].headers;
    const csp = headers.find((row) => row.key === 'Content-Security-Policy').value;
    assert.match(csp, /connect-src 'self' https:\/\/supabase-uat\.srv1866578\.hstgr\.cloud/);
    assert.match(csp, /form-action 'self'/);
    assert.ok(!csp.includes('xtwlrjqbusadghavchqm'));
    assert.ok(!csp.includes('kywdmxpmlualztgwfokg'));
  });
  const { default: ordinary } = await loadUatEntrypoint('next.config.ts');
  assert.equal(ordinary.output, undefined);
  assert.equal((await ordinary.headers())[0].headers[0].value, "frame-ancestors 'none'");
});

test('actual Node instrumentation installs the UAT network fence before application work', async () => {
  const previousRuntime = process.env.NEXT_RUNTIME;
  const previousFetch = globalThis.fetch;
  const marker = Symbol.for('mam.uat.fetch-guard-installed');
  const previousMarker = globalThis[marker];
  const calls = [];
  globalThis.fetch = async (input, init) => { calls.push(new Request(input, init).url); return Response.json({}); };
  try {
    await withUatEnvironment(async () => {
      process.env.NEXT_RUNTIME = 'nodejs';
      const { register } = await loadUatEntrypoint('src/instrumentation.ts');
      await register();
      await globalThis.fetch(uatEnvironment().NEXT_PUBLIC_SUPABASE_URL + '/auth/v1/user');
      assert.deepEqual(calls, ['http://uat-gateway:8080/auth/v1/user']);
      await assert.rejects(() => globalThis.fetch('https://graph.microsoft.com/v1.0/me'), /UAT/);
      assert.equal(calls.length, 1);
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousMarker === undefined) delete globalThis[marker]; else globalThis[marker] = previousMarker;
    if (previousRuntime === undefined) delete process.env.NEXT_RUNTIME; else process.env.NEXT_RUNTIME = previousRuntime;
  }
});

test('runtime instrumentation refuses a build-only configuration rather than disabling its network fence', async () => {
  const previousRuntime = process.env.NEXT_RUNTIME;
  const previousBuildOnly = process.env.MAM_UAT_BUILD_ONLY;
  try {
    await withUatEnvironment(async () => {
      process.env.NEXT_RUNTIME = 'nodejs';
      process.env.MAM_UAT_BUILD_ONLY = 'true';
      const { register } = await loadUatEntrypoint('src/instrumentation.ts');
      await assert.rejects(() => register(), /UAT/);
    });
  } finally {
    if (previousRuntime === undefined) delete process.env.NEXT_RUNTIME; else process.env.NEXT_RUNTIME = previousRuntime;
    if (previousBuildOnly === undefined) delete process.env.MAM_UAT_BUILD_ONLY; else process.env.MAM_UAT_BUILD_ONLY = previousBuildOnly;
  }
});
