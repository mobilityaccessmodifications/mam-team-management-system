import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { NextRequest, NextResponse } from 'next/server.js';
import { loadMailHarness } from './performance-review-mail-harness.mjs';

export function loadMailProxyHarness(options = {}) {
  const h = loadMailHarness(options);
  const counts = { configured: 0, config: 0, client: 0, claims: 0 };
  const source = readFileSync(new URL('../../src/proxy.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const ports = {
    'next/server': { NextResponse },
    '@supabase/ssr': { createServerClient() {
      counts.client++;
      return { auth: { async getClaims() { counts.claims++; return { data: { claims: null } }; } } };
    } },
    '@/lib/supabase/config': {
      isSupabaseConfigured() { counts.configured++; return options.configured ?? true; },
      requireSupabaseConfig() { counts.config++; return { supabaseUrl: 'http://127.0.0.1:54321', supabasePublishableKey: 'synthetic' }; },
    },
    '@/lib/asset-qr': { assetLoginReturnPath: () => null },
  };
  const mod = { exports: {} };
  new Function('require','module','exports',compiled)(id => { assert.ok(Object.hasOwn(ports, id), id); return ports[id]; }, mod, mod.exports);
  return { h, counts, proxy: mod.exports.proxy, async handle(request) {
    const response = await mod.exports.proxy(new NextRequest(request.clone()));
    return response.headers.get('x-middleware-next') === '1' ? h.route()[request.method](request) : response;
  } };
}
