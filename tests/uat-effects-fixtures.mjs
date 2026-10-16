import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { loadUatEntrypoint } from './uat-fixtures.mjs';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const UNAVAILABLE = 'This operation is unavailable in UAT.';
export const PERSON = '10000000-0000-4000-8000-000000000001';
export const USER = '10000000-0000-4000-8000-000000000002';
export const ACTOR = '10000000-0000-4000-8000-000000000003';
export const SECRET = 'synthetic-effects-credential-00000000000000000001';
export const PASSWORD = 'Synthetic-Password-123!';
export const ok = data => ({ data, error: null });
export const form = values => {
  const value = new FormData();
  for (const [key, item] of Object.entries(values)) value.set(key, item);
  return value;
};

const ENVIRONMENT = {
  MAM_UAT_ENABLED: 'true', NEXT_PUBLIC_MAM_UAT_ENABLED: 'false', MAM_UAT_TARGET: '',
  NEXT_PUBLIC_SUPABASE_URL: 'https://database.example.invalid', NEXT_PUBLIC_APP_URL: 'https://app.example.invalid',
  CRON_SECRET: SECRET, MAM_BACKGROUND_RECOVERY_SECRET: SECRET,
  MAM_SUBSCRIPTION_REQUEST_CRON_SECRET: SECRET, MAM_ANALYTICS_API_KEY: SECRET,
  MAM_N8N_LEAVE_WEBHOOK_SECRET: SECRET, MAM_N8N_LEAVE_WEBHOOK_ORIGIN: 'https://receiver.example.invalid',
  MAM_N8N_LEAVE_WEBHOOK_URL: 'https://receiver.example.invalid/webhook/notifications',
  MAM_SUBSCRIPTION_REVIEW_MAIL_START_ON: '2026-10-01',
  CHECK_IN_EMAIL_MODE: 'live', NEW_STARTER_DAY_ONE_EMAIL_MODE: 'live',
  N8N_CHECKIN_REMINDER_WEBHOOK_SECRET: SECRET,
  N8N_CHECKIN_REMINDER_WEBHOOK_ORIGIN: 'https://receiver.example.invalid',
  N8N_CHECKIN_REMINDER_WEBHOOK_URL: 'https://receiver.example.invalid/webhook/check-in',
  N8N_NEW_STARTER_WEBHOOK_ORIGIN: 'https://receiver.example.invalid',
  N8N_NEW_STARTER_WEBHOOK_URL: 'https://receiver.example.invalid/webhook/new-starter',
  CHECK_IN_RESOURCE_ORIGIN: 'https://resources.example.invalid',
  CHECK_IN_MANAGER_GUIDE_URL: 'https://resources.example.invalid/guide',
  CHECK_IN_FORM_URL: 'https://resources.example.invalid/form',
  CHECK_IN_PROBATION_TEMPLATES_URL: 'https://resources.example.invalid/templates',
  ONBOARDING_CREDENTIAL_EMAIL_MODE: 'live', ONBOARDING_CREDENTIAL_WEBHOOK_SECRET: SECRET,
  ONBOARDING_CREDENTIAL_WEBHOOK_ORIGIN: 'https://receiver.example.invalid',
  ONBOARDING_CREDENTIAL_WEBHOOK_URL: 'https://receiver.example.invalid/webhook/mam-people-hub-onboarding-credentials-v1',
  PASSWORD_RECOVERY_WEBHOOK_SECRET: SECRET,
  PASSWORD_RECOVERY_WEBHOOK_ORIGIN: 'https://receiver.example.invalid',
  PASSWORD_RECOVERY_WEBHOOK_URL: 'https://receiver.example.invalid/webhook/mam-people-hub-password-recovery-v1',
  MAM_OPENCLAW_ALLOWLIST_SECRET: SECRET,
  MAM_OPENCLAW_LEAVE_ENABLED: 'true', MAM_OPENCLAW_LEAVE_ACCOUNT: 'synthetic-effects',
  MAM_OPENCLAW_LEAVE_BRIDGE_SECRET: 'synthetic_effects_bridge_credential_00000000000000001',
};

export function exportedMethods(path) {
  const source = ts.createSourceFile(path, readFileSync(ROOT + path, 'utf8'), ts.ScriptTarget.Latest, true);
  return source.statements.flatMap(statement => {
    if (!statement.modifiers?.some(value => value.kind === ts.SyntaxKind.ExportKeyword)) return [];
    if (ts.isFunctionDeclaration(statement)) return [statement.name?.text];
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.map(value => value.name.getText(source));
    return [];
  }).filter(name => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(name)).sort();
}

export function apiMethods() {
  const walk = path => readdirSync(ROOT + path, { withFileTypes: true }).flatMap(entry => {
    const child = path + '/' + entry.name;
    return entry.isDirectory() ? walk(child) : entry.name === 'route.ts' ? [child] : [];
  });
  return walk('src/app/api').sort().flatMap(path => exportedMethods(path).map(method => ({ path, method })));
}

export function apiRequest(path, method) {
  const pathname = '/' + path.replace(/^src\/app\//, '').replace(/\/route\.ts$/, '');
  const url = new URL(pathname, 'https://app.example.invalid');
  const headers = { authorization: `Bearer ${SECRET}`, 'x-mam-notification-secret': SECRET };
  if (pathname.endsWith('/recovery')) url.searchParams.set('job', 'scheduled-offboarding');
  if (pathname.endsWith('/confirmed-test-purge')) {
    headers.origin = url.origin;
    headers['content-type'] = 'application/json';
  }
  if (method === 'POST') {
    const body = pathname.endsWith('/receipts')
      ? JSON.stringify({ action: 'reserve', eventKey: `onboarding-credential:${PERSON}`, recipient: 'synthetic@example.invalid', cc: '', legacyEventKey: null })
      : pathname.endsWith('/openclaw/leave')
        ? JSON.stringify({ version: 3, account: 'synthetic-effects', channel: 'whatsapp', sender: '+61400000000', session: 'synthetic-session', eventId: 'synthetic-event', operation: 'prepare', payload: {} })
        : '{}';
    headers['content-type'] = 'application/json';
    headers['x-mam-timestamp'] = String(Date.now());
    headers['x-mam-signature'] = createHmac('sha256', ENVIRONMENT.MAM_OPENCLAW_LEAVE_BRIDGE_SECRET).update(`POST\n${pathname}\n${headers['x-mam-timestamp']}\n${body}`).digest('hex');
    return new Request(url, { method, headers, body });
  }
  return new Request(url, { method, headers });
}

export function fixture({ uat = true, overrides = {}, admin, client, ports = {} } = {}) {
  const original = Object.fromEntries(Object.keys(ENVIRONMENT).map(key => [key, process.env[key]]));
  Object.assign(process.env, ENVIRONMENT, { MAM_UAT_ENABLED: uat ? 'true' : 'false' }, overrides);
  const calls = [];
  const callbacks = [];
  const previousFetch = globalThis.fetch;
  const previousDate = globalThis.Date;
  class FixtureDate extends previousDate {
    constructor(...args) { super(...(args.length ? args : ['2026-10-16T00:00:00.000Z'])); }
    static now() { return new previousDate('2026-10-16T00:00:00.000Z').valueOf(); }
  }
  globalThis.Date = FixtureDate;
  const hit = (name, ...args) => {
    calls.push(name);
    if (Object.hasOwn(ports, name)) return ports[name](...args);
    throw new Error('Unexpected inert boundary: ' + name);
  };
  globalThis.__uatEffects = { hit, callbacks, admin: () => { calls.push('admin'); return admin ?? hit('admin.unconfigured'); }, client: () => { calls.push('client'); return client ?? hit('client.unconfigured'); } };
  globalThis.fetch = (...args) => hit('provider.fetch', ...args);
  const mocks = {
    'server-only': '',
    '@/lib/supabase/admin': 'export const createAdminClient = () => globalThis.__uatEffects.admin();',
    './supabase/admin': 'export const createAdminClient = () => globalThis.__uatEffects.admin();',
    '@/lib/supabase/server': 'export const createClient = async () => globalThis.__uatEffects.client();',
    'next/headers': 'export const headers = async () => globalThis.__uatEffects.hit("headers"); export const cookies = async () => globalThis.__uatEffects.hit("cookies");',
    'next/cache': 'export const revalidatePath = (...args) => globalThis.__uatEffects.hit("revalidate", ...args); export const revalidateTag = (...args) => globalThis.__uatEffects.hit("revalidateTag", ...args);',
    'next/server': 'export const after = callback => {globalThis.__uatEffects.hit("after"); globalThis.__uatEffects.callbacks.push(callback);};',
    'next/navigation': 'export const redirect = url => globalThis.__uatEffects.hit("redirect", url);',
    '@/app/confirmed-test-purge/actions': 'export const confirmedTestIdentityPurge = input => globalThis.__uatEffects.hit("purge", input);',
    '@/lib/operator-session-proof': 'export const verifyOperatorSession = input => globalThis.__uatEffects.hit("proof", input);',
    'node:crypto': 'export * from "crypto"; export const randomBytes = (...args) => globalThis.__uatEffects.hit("randomBytes", ...args);',
  };
  return {
    calls, callbacks, hit,
    load: (path, extra = {}) => loadUatEntrypoint(path, { ...mocks, ...extra }),
    async flush() { for (const callback of callbacks.splice(0)) await callback(); },
    assertZero(label) { assert.deepEqual(calls, [], label + ' must be lazy before auth/admin/claim/provider/after'); },
    observe(label, result) { console.log('EFFECTS_OBSERVATION ' + JSON.stringify({ label, calls, result })); },
    cleanup() {
      for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      globalThis.fetch = previousFetch;
      globalThis.Date = previousDate;
      delete globalThis.__uatEffects;
    },
  };
}

export function sourceDigest(path) { return createHash('sha256').update(readFileSync(ROOT + path)).digest('hex'); }
