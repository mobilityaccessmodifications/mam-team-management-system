import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { loadModule } from './helpers/unified-role-harness.mjs';

import {
  buildNewStarterDayOneWorkflow,
  CHECKLIST_PATH,
  TEST_RECIPIENT,
} from '../scripts/build-new-starter-day-one-workflow.mjs';

const require = createRequire(import.meta.url);
const ackModule = { exports: {} };
new Function('require', 'module', 'exports', ts.transpileModule(readFileSync('src/lib/check-in-delivery-ack.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(require, ackModule, ackModule.exports);
const teamModule = { exports: {} };
new Function('exports', ts.transpileModule(readFileSync('src/lib/employee-teams.ts','utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(teamModule.exports);
const reminderId = '10000000-0000-4000-8000-000000000001';
const claimToken = '20000000-0000-4000-8000-000000000001';

function loadRoute(admin) {
  const source = ts.transpileModule(readFileSync('src/app/api/cron/new-starter-day-one/route.ts','utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  new Function('require','module','exports',source)((id) => id === '@/lib/supabase/admin'
    ? { createAdminClient: () => admin } : id === '@/lib/check-in-delivery-ack'
      ? ackModule.exports : require(id), mod, mod.exports);
  return mod.exports;
}

function request() {
  return new Request('https://people.example.test/api/cron/new-starter-day-one', {
    headers: { authorization: 'Bearer synthetic-cron' },
  });
}

test('Day 1 test workflow hard-routes to Marketing and attaches the reviewed checklist from AI Outlook', () => {
  const workflow = buildNewStarterDayOneWorkflow({ mode: 'test' });
  const byName = Object.fromEntries(workflow.nodes.map((node) => [node.name,node]));
  const validator = new Function('$input',byName['Validate Day 1 Request'].parameters.jsCode);
  const testPayload = {
    version: 1, event: 'new-starter-day-one', mode: 'test',
    deliveryId: `new-starter:${reminderId}:day-one:test`,
    employee: { firstName: 'Taylor', role: 'Coordinator', company: 'mam', workEmail: 'work@example.test', personalEmail: 'home@example.test' },
    manager: { firstName: 'Morgan', email: 'manager@example.test' }, commencementDate: '2026-10-05',
  };
  const [validated] = validator({ first: () => ({ json: { body: testPayload } }) });
  assert.equal(validated.json.valid,true);
  assert.equal(validated.json.actualRecipient,TEST_RECIPIENT);
  assert.ok(!JSON.stringify(validated).includes('work@example.test'));
  assert.ok(!JSON.stringify(validated).includes('home@example.test'));
  assert.ok(!JSON.stringify(validated).includes('manager@example.test'));

  const [rejected] = validator({ first: () => ({ json: { body: { ...testPayload, mode: 'live', deliveryId: `new-starter:${reminderId}:day-one:live` } } }) });
  assert.equal(rejected.json.valid,false);
  const send = byName['Send Day 1 Email from HR'];
  assert.equal(send.credentials.microsoftOutlookOAuth2Api.name,'Microsoft Outlook - ai@mobilityaccess.com.au');
  assert.deepEqual(send.parameters.additionalFields.attachments.attachments,[{ binaryPropertyName: 'checklist' }]);
  assert.equal(send.retryOnFail,undefined);
  const build = byName['Build Day 1 Email and Attachment'].parameters.jsCode;
  const encoded = build.match(/data: "([A-Za-z0-9+/=]+)"/u)?.[1];
  assert.ok(encoded);
  assert.deepEqual(Buffer.from(encoded,'base64'),readFileSync(CHECKLIST_PATH));
  assert.match(build,/Welcome to MAM\/Equipsy – Your First Day/);
});

test('live workflow includes both employee addresses once and the direct manager', () => {
  const workflow = buildNewStarterDayOneWorkflow({ mode: 'live' });
  assert.equal(workflow.settings.saveDataErrorExecution,'none');
  const validatorNode = workflow.nodes.find((node) => node.name === 'Validate Day 1 Request');
  const validator = new Function('$input',validatorNode.parameters.jsCode);
  const payload = {
    version: 1, event: 'new-starter-day-one', mode: 'live',
    deliveryId: `new-starter:${reminderId}:day-one:live`,
    employee: { firstName: 'Taylor', role: 'Coordinator', company: 'equipsy', workEmail: 'same@example.test', personalEmail: 'same@example.test' },
    manager: { firstName: 'Morgan', email: 'manager@example.test' }, commencementDate: '2026-10-05',
  };
  const [same] = validator({ first: () => ({ json: payload }) });
  assert.equal(same.json.actualRecipient,'manager@example.test,same@example.test');
  payload.employee.personalEmail = 'personal@example.test';
  const [both] = validator({ first: () => ({ json: payload }) });
  assert.equal(both.json.actualRecipient,'manager@example.test,personal@example.test,same@example.test');
  assert.equal(both.json.deliveryTo,'manager@example.test,same@example.test');
  assert.equal(both.json.deliveryBcc,'personal@example.test');
  const send = workflow.nodes.find((node) => node.name === 'Send Day 1 Email from HR');
  assert.equal(send.parameters.toRecipients,'={{ $json.deliveryTo }}');
  assert.equal(send.parameters.additionalFields.bccRecipients,'={{ $json.deliveryBcc }}');
});

test('Day 1 dispatcher stays inert for unsupported or disabled modes', async () => {
  const previous = { ...process.env };
  process.env.CRON_SECRET = 'synthetic-cron';
  process.env.NEW_STARTER_DAY_ONE_EMAIL_MODE = 'test';
  try {
    const admin = { rpc: async () => { throw new Error('disabled mode must not claim reminders'); } };
    const response = await loadRoute(admin).GET(request());
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{ ok: true, code: 'delivery_disabled', claimed: 0, sent: 0, failed: 0 });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env,previous);
  }
});

test('dispatcher uses separate Marketing-test and live delivery contracts', async () => {
  const previousEnv = { ...process.env };
  const previousFetch = globalThis.fetch;
  const PreviousDate = globalThis.Date;
  Object.assign(process.env,{
    CRON_SECRET: 'synthetic-cron',
    N8N_NEW_STARTER_WEBHOOK_ORIGIN: 'https://n8n.example.test',
    N8N_NEW_STARTER_WEBHOOK_URL: 'https://n8n.example.test/webhook/day-one',
    N8N_CHECKIN_REMINDER_WEBHOOK_SECRET: 'x'.repeat(40),
  });
  globalThis.Date = class extends PreviousDate { constructor(...args) { super(...(args.length ? args : ['2026-09-23T00:00:00Z'])); } };
  const calls = [];
  const admin = { rpc: async (name,args) => {
    calls.push({ name,args });
    if (name === 'claim_due_new_starter_day_one_reminders') return { data: [{ reminder_id: reminderId, claim_token: claimToken }], error: null };
    if (name === 'prepare_new_starter_day_one_delivery') return { data: [{
      reminder_id: reminderId, employee_first_name: 'Taylor', employee_work_email: 'work@example.test',
      employee_personal_email: 'personal@example.test', role: 'Coordinator', company_key: 'mam',
      manager_first_name: 'Morgan', manager_email: 'manager@example.test', commencement_date: '2026-10-05', notify_date: '2026-10-02',
    }], error: null };
    if (name === 'complete_new_starter_day_one_delivery') return { data: true, error: null };
    throw new Error(`unexpected RPC ${name}`);
  } };
  try {
    for (const [configuredMode,contractMode] of [['marketing-test','test'],['live','live']]) {
      process.env.NEW_STARTER_DAY_ONE_EMAIL_MODE = configuredMode;
      let body;
      globalThis.fetch = async (_url,options) => {
        body = JSON.parse(options.body);
        return Response.json({ ok: true, sent: true, alreadySent: false,
          deliveryId: `new-starter:${reminderId}:day-one:${contractMode}` });
      };
      const response = await loadRoute(admin).GET(request());
      assert.equal(response.status,200);
      assert.equal((await response.json()).sent,1);
      assert.equal(body.mode,contractMode);
      assert.equal(body.deliveryId,`new-starter:${reminderId}:day-one:${contractMode}`);
      assert.equal(body.employee.workEmail,'work@example.test');
      assert.equal(body.employee.personalEmail,'personal@example.test');
      assert.equal(body.manager.email,'manager@example.test');
    }
    assert.ok(calls.some((call) => call.name === 'complete_new_starter_day_one_delivery'));
    assert.ok(!calls.some((call) => call.name === 'fail_new_starter_day_one_delivery'));
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.Date = PreviousDate;
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env,previousEnv);
  }
});

test('a claimed reminder moved to review is surfaced as an incomplete recovery run', async () => {
  const previousEnv = { ...process.env };
  const PreviousDate = globalThis.Date;
  Object.assign(process.env,{
    CRON_SECRET:'synthetic-cron',NEW_STARTER_DAY_ONE_EMAIL_MODE:'live',
    N8N_NEW_STARTER_WEBHOOK_ORIGIN:'https://n8n.example.test',N8N_NEW_STARTER_WEBHOOK_URL:'https://n8n.example.test/webhook/day-one',
    N8N_CHECKIN_REMINDER_WEBHOOK_SECRET:'x'.repeat(40),
  });
  globalThis.Date = class extends PreviousDate { constructor(...args) { super(...(args.length ? args : ['2026-09-23T00:00:00Z'])); } };
  const admin = { rpc: async (name) => {
    if (name === 'claim_due_new_starter_day_one_reminders') return { data:[{ reminder_id:reminderId,claim_token:claimToken }],error:null };
    if (name === 'prepare_new_starter_day_one_delivery') return { data:[],error:null };
    throw new Error(`unexpected RPC ${name}`);
  } };
  try {
    const response = await loadRoute(admin).GET(request());
    assert.equal(response.status,503);
    assert.deepEqual(await response.json(),{ ok:false,code:'delivery_incomplete',claimed:1,sent:0,failed:1 });
  } finally {
    globalThis.Date = PreviousDate;
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env,previousEnv);
  }
});

test('a prepared reminder that fails local validation releases its claim through the retry path', async () => {
  const previousEnv = { ...process.env };
  const PreviousDate = globalThis.Date;
  Object.assign(process.env,{
    CRON_SECRET:'synthetic-cron',NEW_STARTER_DAY_ONE_EMAIL_MODE:'live',
    N8N_NEW_STARTER_WEBHOOK_ORIGIN:'https://n8n.example.test',N8N_NEW_STARTER_WEBHOOK_URL:'https://n8n.example.test/webhook/day-one',
    N8N_CHECKIN_REMINDER_WEBHOOK_SECRET:'x'.repeat(40),
  });
  globalThis.Date = class extends PreviousDate { constructor(...args) { super(...(args.length ? args : ['2026-09-23T00:00:00Z'])); } };
  const failures = [];
  const admin = { rpc: async (name,args) => {
    if (name === 'claim_due_new_starter_day_one_reminders') return { data:[{ reminder_id:reminderId,claim_token:claimToken }],error:null };
    // The database accepts this address, but the delivery contract requires a domain dot.
    if (name === 'prepare_new_starter_day_one_delivery') return { data:[{
      reminder_id:reminderId,employee_first_name:'Taylor',employee_work_email:'work@example.test',
      employee_personal_email:null,role:'Coordinator',company_key:'mam',
      manager_first_name:'Morgan',manager_email:'manager@localhost',commencement_date:'2026-10-05',notify_date:'2026-10-02',
    }],error:null };
    if (name === 'fail_new_starter_day_one_delivery') { failures.push(args); return { data:true,error:null }; }
    throw new Error(`unexpected RPC ${name}`);
  } };
  try {
    const response = await loadRoute(admin).GET(request());
    assert.equal(response.status,503);
    assert.deepEqual(await response.json(),{ ok:false,code:'delivery_incomplete',claimed:1,sent:0,failed:1 });
    assert.deepEqual(failures,[{ p_reminder_id:reminderId,p_claim_token:claimToken,p_error_code:'configuration_error' }]);
  } finally {
    globalThis.Date = PreviousDate;
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env,previousEnv);
  }
});

test('new active employee creation still requires a start date before mutation', async () => {
  const source = ts.transpileModule(readFileSync('src/app/people/actions.ts','utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let rpcCalls = 0;
  const supabase = { rpc: async () => { rpcCalls += 1; throw new Error('must not mutate'); } };
  const mod = { exports: {} };
  new Function('require','module','exports',source)((id) => ({
    '@/lib/portal-role-capabilities': loadModule('src/lib/portal-role-capabilities.ts'),
    '@/lib/portal-role-access': loadModule('src/lib/portal-role-access.ts', { '@/lib/supabase/server': { createClient: async () => supabase } }),
    '@/lib/employee-teams': teamModule.exports,
    'next/cache': { revalidatePath: () => {} },
    '@/lib/employee-directory': {
      requireEmployeeDirectoryManager: async () => ({ supabase }),
      findEmployeeDirectoryRecord: async () => null,
      listEmployeeDirectoryRecordsForManager: async () => [],
    },
    '@/lib/organisation-directory': { getOrganisationPersonWorkEmailForMember: async () => null },
    '@/app/accounts/actions': { createPortalAccount: async () => ({}) },
    '@/lib/supabase/admin': { createAdminClient: () => ({}) },
    '@/lib/portal-account-status': {
      preparePortalAccountStatusChange: async () => ({}), finalisePortalAccountStatusChange: async () => ({}), recoverPortalAccountStatusChange: async () => ({}),
    },
  })[id] ?? require(id),mod,mod.exports);
  const valid = {
    firstName:'Taylor',lastName:'Starter',workEmail:'work@example.test',personalEmail:'home@example.test',phone:'',
    positionTitle:'Coordinator',teamName:'Operation & Accounts',managerId:reminderId,country:'',address:'',dateOfBirth:'',
    startedDate:'2026-10-05',scheduledEmploymentEndDate:'',workingWeekdays:null,workingDayTimes:[],archiveReason:'',
    employmentType:'full_time',laptopSupplied:'',laptopId:'',mouseId:'',keyboardId:'',assetTags:[],company:'mam',isActive:true,
  };
  assert.deepEqual(await mod.exports.createEmployeeDirectoryRecord({ ...valid,startedDate:'' }), { error: 'A start date is required for a new active employee.' });
  assert.equal(rpcCalls,0);
});

test('active directory-only create without email skips portal-account provisioning', async () => {
  const source = ts.transpileModule(readFileSync('src/app/people/actions.ts','utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const accountCalls = [];
  const supabase = { rpc: async (name) => {
    if (name === 'get_employee_team_manager_default') return { data: { status: 'missing', managerId: null, managerName: '' }, error: null };
    assert.equal(name,'create_employee_directory_record_with_work_schedule_times');
    return { data:[{ person_id:reminderId }],error:null };
  } };
  const mod = { exports: {} };
  new Function('require','module','exports',source)((id) => ({
    '@/lib/portal-role-capabilities': loadModule('src/lib/portal-role-capabilities.ts'),
    '@/lib/portal-role-access': loadModule('src/lib/portal-role-access.ts', { '@/lib/supabase/server': { createClient: async () => supabase } }),
    '@/lib/employee-teams': teamModule.exports,
    'next/cache': { revalidatePath: () => {} },
    '@/lib/employee-directory': {
      requireEmployeeDirectoryManager: async () => ({ supabase }),
      findEmployeeDirectoryRecord: async () => ({ personId:reminderId,personVersion:1 }),
      listEmployeeDirectoryRecordsForManager: async () => [],
    },
    '@/lib/organisation-directory': { getOrganisationPersonWorkEmailForMember: async () => null },
    '@/app/accounts/actions': { createPortalAccount: async (input) => { accountCalls.push(input); } },
    '@/lib/supabase/admin': { createAdminClient: () => ({}) },
    '@/lib/portal-account-status': {
      preparePortalAccountStatusChange: async () => ({}), finalisePortalAccountStatusChange: async () => ({}), recoverPortalAccountStatusChange: async () => ({}),
    },
  })[id] ?? require(id),mod,mod.exports);
  const result = await mod.exports.createEmployeeDirectoryRecord({
    firstName:'Taylor',lastName:'Starter',workEmail:'',personalEmail:'',phone:'',
    positionTitle:'Coordinator',teamName:'Operation & Accounts',managerId:null,country:'',address:'',dateOfBirth:'',
    startedDate:'2026-10-05',scheduledEmploymentEndDate:'',workingWeekdays:null,workingDayTimes:[],archiveReason:'',
    employmentType:'full_time',laptopSupplied:'',laptopId:'',mouseId:'',keyboardId:'',assetTags:[],company:'mam',isActive:true,
  });
  assert.equal(result.record.personId,reminderId);
  assert.match(result.warning,/without a portal account/i);
  assert.equal(accountCalls.length,0);
});
