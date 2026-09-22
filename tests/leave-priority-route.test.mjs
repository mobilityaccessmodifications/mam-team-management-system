import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { loadAssetQrModule } from './asset-qr-test-loader.mjs';
import { Receiver } from './notification-workflow-harness.mjs';
const require = createRequire(import.meta.url);
const ts = require('typescript');

function load(file, imports) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loadedModule = { exports: {} };
  new Function('require', 'module', 'exports', code)((id) => {
    if (id in imports) return imports[id];
    throw new Error(`Unexpected import: ${id}`);
  }, loadedModule, loadedModule.exports);
  return loadedModule.exports;
}

async function withPriorityReminder({ receiver = new Receiver(), mutateReceipt = value => value,
  complete = () => true, managerEmail = 'zeta@example.test,alpha@example.test,middle@example.test' } = {}, run) {
  const calls = [];
  const reminder = {
    delivery_id: '40000000-0000-4000-8000-000000000001', claim_token: '40000000-0000-4000-8000-000000000002',
    event: 'leave-reminder', source_id: '40000000-0000-4000-8000-000000000003',
    employee_name: 'Synthetic Employee', manager_email: managerEmail, company: 'mam',
    leave_type: 'Annual leave', start_date: '2026-10-12', end_date: '2026-10-13', status: 'Pending',
  };
  const { GET } = load('src/app/api/cron/leave-priority-reminders/route.ts', {
    'node:crypto': require('node:crypto'),
    '@/lib/supabase/admin': { createAdminClient: () => ({ rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === 'claim_leave_priority_reminders') return { data: [reminder], error: null };
      if (name === 'claim_due_payroll_balance_email_reminders') return { data: [], error: null };
      if (name === 'complete_leave_priority_reminder') return { data: complete(), error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    } }) },
  });
  const values = { CRON_SECRET: 'synthetic-cron-secret', MAM_N8N_LEAVE_WEBHOOK_ORIGIN: 'https://n8n.example.test',
    MAM_N8N_LEAVE_WEBHOOK_URL: 'https://n8n.example.test/webhook/mam', MAM_N8N_LEAVE_WEBHOOK_SECRET: 'synthetic-webhook-secret' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const oldFetch = globalThis.fetch, oldFormat = Intl.DateTimeFormat;
  Object.assign(process.env, values);
  Object.defineProperty(Intl, 'DateTimeFormat', { configurable: true, writable: true, value: function () { return { format: () => '08' }; } });
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), values.MAM_N8N_LEAVE_WEBHOOK_URL);
    assert.equal(options.headers['X-MAM-Notification-Secret'], values.MAM_N8N_LEAVE_WEBHOOK_SECRET);
    return Response.json(mutateReceipt(receiver.run(JSON.parse(options.body))));
  };
  try {
    await run({ receiver, calls, invoke: () => GET(new Request('https://example.test/api/cron/leave-priority-reminders', {
      headers: { authorization: 'Bearer synthetic-cron-secret' },
    })) });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    globalThis.fetch = oldFetch;
    Object.defineProperty(Intl, 'DateTimeFormat', { configurable: true, writable: true, value: oldFormat });
  }
}

test('group reminder accepts the exact durable receiver recipient set in a different order', async () => {
  await withPriorityReminder({}, async ({ invoke, calls, receiver }) => {
    const result = await invoke();
    assert.equal(result.status, 200);
    assert.deepEqual((await result.json()).leavePriority, { ok: true, claimed: 1, sent: 1, failed: 0 });
    assert.equal(calls.filter(call => call.name === 'complete_leave_priority_reminder').length, 1);
    assert.equal(receiver.sends.length, 1);
    assert.equal(receiver.sends[0].ccRecipients, '');
  });
});

test('group reminder retry finalizes the original durable receipt without a second send', async () => {
  let completions = 0;
  await withPriorityReminder({ complete: () => ++completions > 1 }, async ({ invoke, receiver }) => {
    assert.equal((await invoke()).status, 502);
    assert.equal((await invoke()).status, 200);
    assert.equal(completions, 2);
    assert.equal(receiver.sends.length, 1);
    assert.deepEqual(receiver.api.requests.map(request => request.action), ['reserve', 'confirm', 'reserve']);
  });
});

for (const [label, patch] of [
  ['missing recipient', { actualRecipient: 'alpha@example.test,middle@example.test' }],
  ['extra recipient', { actualRecipient: 'alpha@example.test,middle@example.test,zeta@example.test,outsider@example.test' }],
  ['malformed recipient', { actualRecipient: 'alpha@example.test,middle@example.test,zeta@example.test,not-an-email' }],
  ['trailing empty recipient', { actualRecipient: 'alpha@example.test,middle@example.test,zeta@example.test,' }],
  ['non-string recipient', { actualRecipient: ['alpha@example.test', 'middle@example.test', 'zeta@example.test'] }],
  ['unexpected CC', { actualCcRecipients: 'outsider@example.test' }],
  ['missing CC evidence', { actualCcRecipients: undefined }],
  ['mismatched event key', { eventKey: 'wrong-key' }],
  ['failed receipt', { ok: false }],
  ['unconfirmed receipt', { sent: false, alreadySent: false }],
]) {
  test(`group reminder does not finalize a receipt with ${label}`, async () => {
    await withPriorityReminder({ mutateReceipt: value => ({ ...value, ...patch }) }, async ({ invoke, calls }) => {
      assert.equal((await invoke()).status, 502);
      assert.equal(calls.filter(call => call.name === 'complete_leave_priority_reminder').length, 0);
    });
  });
}

test('group reminder compares case-insensitive sets without duplicating a repeated address', async () => {
  await withPriorityReminder({ managerEmail: 'Zeta@example.test,alpha@example.test,zeta@example.test' }, async ({ invoke, receiver }) => {
    assert.equal((await invoke()).status, 200);
    assert.equal(receiver.sends.length, 1);
    assert.equal(receiver.api.rows.values().next().value.actualRecipient, 'alpha@example.test,zeta@example.test');
  });
});

test('scheduler reaches bearer-auth handler without a browser login; private pages stay protected', async () => {
  const { proxy } = load('src/proxy.ts', {
    '@/lib/asset-qr': loadAssetQrModule(),
    '@supabase/ssr': { createServerClient: () => ({ auth: { getClaims: async () => ({ data: { claims: null } }) } }) },
    'next/server': { NextResponse: { next: () => ({ status: 200 }), redirect: () => ({ status: 307 }) } },
    '@/lib/supabase/config': { isSupabaseConfigured: () => true, requireSupabaseConfig: () => ({ supabaseUrl: 'https://example.test', supabasePublishableKey: 'test' }) },
  });
  const request = (pathname) => ({ nextUrl: { pathname, clone: () => new URL(`https://example.test${pathname}`) }, cookies: { getAll: () => [] } });
  assert.equal((await proxy(request('/api/cron/leave-priority-reminders'))).status, 200);
  assert.equal((await proxy(request('/api/cron/leave-accrual'))).status, 200);
  assert.equal((await proxy(request('/'))).status, 307);
  assert.equal((await proxy(request('/api/cron/not-authorised'))).status, 307);
});

test('missing bearer is denied before any database access', async () => {
  const { GET } = load('src/app/api/cron/leave-priority-reminders/route.ts', {
    'node:crypto': require('node:crypto'),
    '@/lib/supabase/admin': { createAdminClient: () => { throw new Error('Database must not be reached'); } },
  });
  assert.equal((await GET(new Request('https://example.test/api/cron/leave-priority-reminders'))).status, 401);
});

test('workday payroll claim posts the strict n8n event and completes only after an exact receipt', async () => {
  const reminderId = '30000000-0000-4000-8000-000000000001';
  const claimToken = '30000000-0000-4000-8000-000000000002';
  const calls = [];
  const client = { rpc: async (name, args) => {
    calls.push({name,args});
    if (name === 'claim_leave_priority_reminders') return {data:[],error:null};
    if (name === 'claim_due_payroll_balance_email_reminders') return {data:[{reminder_id:reminderId,claim_token:claimToken}],error:null};
    if (name === 'prepare_payroll_balance_email_reminder_delivery') return {data:[{
      reminder_id:reminderId,delivery_required:true,recipient_name:'Gerard',recipient_email:'gerard@example.test',
      reminder_month:'2026-10-01',missing_companies:['mam','equipsy'],
    }],error:null};
    if (name === 'complete_payroll_balance_email_reminder_delivery') return {data:true,error:null};
    throw new Error(`Unexpected RPC: ${name}`);
  }};
  const { GET } = load('src/app/api/cron/leave-priority-reminders/route.ts', {
    'node:crypto': require('node:crypto'),
    '@/lib/supabase/admin': { createAdminClient: () => client },
  });
  const previous = {
    cron: process.env.CRON_SECRET,
    origin: process.env.MAM_N8N_LEAVE_WEBHOOK_ORIGIN,
    url: process.env.MAM_N8N_LEAVE_WEBHOOK_URL,
    webhook: process.env.MAM_N8N_LEAVE_WEBHOOK_SECRET,
    fetch: globalThis.fetch,
    dateTimeFormat: Intl.DateTimeFormat,
  };
  process.env.CRON_SECRET='synthetic-cron-secret';
  process.env.MAM_N8N_LEAVE_WEBHOOK_ORIGIN='https://n8n.example.test';
  process.env.MAM_N8N_LEAVE_WEBHOOK_URL='https://n8n.example.test/webhook/mam';
  process.env.MAM_N8N_LEAVE_WEBHOOK_SECRET='synthetic-webhook-secret';
  Object.defineProperty(Intl,'DateTimeFormat',{configurable:true,writable:true,value:function(){return {format:()=> '08'};}});
  globalThis.fetch=async (url,options) => {
    assert.equal(String(url),'https://n8n.example.test/webhook/mam');
    assert.equal(options.headers['X-MAM-Notification-Secret'],'synthetic-webhook-secret');
    const body=JSON.parse(options.body);
    assert.deepEqual(body,{
      version:1,event:'payroll-balance-reminder',
      eventKey:`payroll-balance:${reminderId}:2026-10`,requestId:reminderId,
      recipientName:'Gerard',recipientEmail:'gerard@example.test',reminderMonth:'2026-10-01',
      missingCompanies:['mam','equipsy'],
    });
    assert.equal(options.headers['Idempotency-Key'],body.eventKey);
    return Response.json({ok:true,sent:true,alreadySent:false,actualRecipient:body.recipientEmail,eventKey:body.eventKey});
  };
  try {
    const result=await GET(new Request('https://example.test/api/cron/leave-priority-reminders',{
      headers:{authorization:'Bearer synthetic-cron-secret'},
    }));
    assert.equal(result.status,200);
    const body=await result.json();
    assert.equal(body.ok,true);
    assert.deepEqual(body.payrollBalanceEmail,{ok:true,claimed:1,sent:1,failed:0,notRequired:0,acceptedPendingFinalisation:0});
    assert(calls.some((call)=>call.name==='complete_payroll_balance_email_reminder_delivery'
      && call.args.p_provider_delivery_id===`payroll-balance:${reminderId}:2026-10`));
    assert(!calls.some((call)=>call.name==='fail_payroll_balance_email_reminder_delivery'));
  } finally {
    for (const [key,value] of [['CRON_SECRET',previous.cron],['MAM_N8N_LEAVE_WEBHOOK_ORIGIN',previous.origin],
      ['MAM_N8N_LEAVE_WEBHOOK_URL',previous.url],['MAM_N8N_LEAVE_WEBHOOK_SECRET',previous.webhook]]) {
      if (value === undefined) delete process.env[key]; else process.env[key]=value;
    }
    globalThis.fetch=previous.fetch;
    Object.defineProperty(Intl,'DateTimeFormat',{configurable:true,writable:true,value:previous.dateTimeFormat});
  }
});


test('accrual cron is authenticated, records once and hides database failures', async () => {
  const before = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'synthetic-cron-secret';
  let calls = 0;
  const { GET } = load('src/app/api/cron/leave-accrual/route.ts', {
    'node:crypto': require('node:crypto'),
    '@/lib/supabase/admin': { createAdminClient: () => ({ rpc: async (name) => {
      assert.equal(name, 'refresh_employee_leave_accrual'); calls++;
      return calls === 1 ? { data: 24, error: null } : { data: null, error: { message: 'private-details' } };
    } }) },
  });
  try {
    const url = 'https://example.test/api/cron/leave-accrual';
    assert.equal((await GET(new Request(url))).status, 401);
    assert.equal((await GET(new Request(url, { headers: { authorization: 'Bearer wrong' } }))).status, 401);
    assert.equal(calls, 0);
    const good = () => new Request(url, { headers: { authorization: 'Bearer synthetic-cron-secret' } });
    assert.deepEqual(await (await GET(good())).json(), { ok: true, recorded: 24 });
    const failure = await GET(good());
    assert.equal(failure.status, 500);
    assert.doesNotMatch(await failure.text(), /private-details/);
  } finally {
    if (before === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = before;
  }
});
