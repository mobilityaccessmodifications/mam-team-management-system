import assert from 'node:assert/strict';
import test from 'node:test';
import { loadUatSafety, uatEnvironment, UAT_API_ORIGIN } from './uat-fixtures.mjs';

test('hosted UAT accepts only the isolated target and cannot silently fall back', () => {
  const { assertUatEnvironment, isUatMode } = loadUatSafety();
  const valid = uatEnvironment();
  assert.equal(isUatMode(valid), true);
  assert.doesNotThrow(() => assertUatEnvironment(valid));
  for (const patch of [
    { NEXT_PUBLIC_SUPABASE_URL: 'https://xtwlrjqbusadghavchqm.supabase.co' },
    { NEXT_PUBLIC_SUPABASE_URL: 'https://kywdmxpmlualztgwfokg.supabase.co' },
    { NEXT_PUBLIC_SUPABASE_URL: 'https://unknown-uat.invalid' },
    { NEXT_PUBLIC_SUPABASE_URL: 'http://supabase-uat.srv1866578.hstgr.cloud' },
    { NEXT_PUBLIC_APP_URL: 'https://mam-team-management-system-ten.vercel.app' },
    { NEXT_PUBLIC_APP_URL: undefined },
    { MAM_UAT_ENABLED: undefined },
    { NEXT_PUBLIC_MAM_UAT_ENABLED: undefined },
    { MAM_APP_ENV: 'production' },
    { VERCEL_ENV: 'production' },
    { MAM_UAT_TARGET: 'unknown' },
    { MAM_UAT_INTERNAL_SUPABASE_URL: 'http://n8n-n8n-1:5678' },
    { SUPABASE_SECRET_KEY: valid.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY },
    { NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_wrong_target' },
    { SUPABASE_SECRET_KEY: undefined },
  ]) assert.throws(() => assertUatEnvironment({ ...valid, ...patch }), /UAT/);
  assert.equal(isUatMode({}), false);
  assert.doesNotThrow(() => assertUatEnvironment({ NEXT_PUBLIC_SUPABASE_URL: 'https://xtwlrjqbusadghavchqm.supabase.co' }));
});

test('UAT rejects every outbound operator, notification and cron setting without echoing values', () => {
  const { assertUatEnvironment } = loadUatSafety();
  const names = [
    'SUPABASE_ACCESS_TOKEN', 'N8N_BASE_URL', 'N8N_API_KEY',
    'MAM_N8N_LEAVE_WEBHOOK_URL', 'MAM_N8N_LEAVE_WEBHOOK_SECRET',
    'N8N_CHECKIN_REMINDER_WEBHOOK_ORIGIN', 'N8N_NEW_STARTER_WEBHOOK_URL',
    'ONBOARDING_CREDENTIAL_WEBHOOK_URL', 'ONBOARDING_CREDENTIAL_WEBHOOK_SECRET',
    'PASSWORD_RECOVERY_WEBHOOK_URL', 'PASSWORD_RECOVERY_WEBHOOK_SECRET',
    'CRON_SECRET', 'MAM_BACKGROUND_RECOVERY_SECRET', 'MAM_SUBSCRIPTION_REQUEST_CRON_SECRET',
    'MAM_OPENCLAW_LEAVE_ENABLED', 'MAM_OPENCLAW_LEAVE_ACCOUNT', 'MAM_OPENCLAW_LEAVE_BRIDGE_SECRET',
    'CHECK_IN_EMAIL_MODE', 'NEW_STARTER_DAY_ONE_EMAIL_MODE', 'ONBOARDING_CREDENTIAL_EMAIL_MODE',
    'MAM_DEMO_EMAIL_ENABLED', 'MAM_SUBSCRIPTION_REVIEW_MAIL_START_ON',
    'CHECK_IN_RESOURCE_ORIGIN', 'CHECK_IN_MANAGER_GUIDE_URL', 'CHECK_IN_FORM_URL',
    'CHECK_IN_PROBATION_TEMPLATES_URL', 'CHECK_IN_LEGACY_FORMS_FOLDER_URL', 'MAM_ANALYTICS_API_KEY',
  ];
  for (const name of names) {
    assert.throws(() => assertUatEnvironment({ ...uatEnvironment(), [name]: 'SYNTHETIC_FORBIDDEN_VALUE' }), (error) => {
      assert.match(error.message, /UAT/);
      assert.ok(!error.message.includes('SYNTHETIC_FORBIDDEN_VALUE'));
      return true;
    }, name);
    assert.doesNotThrow(() => assertUatEnvironment({ ...uatEnvironment(), [name]: '' }));
  }
});


test('UAT fetch reaches only its private gateway and refuses redirects or Auth email paths', async () => {
  const { createUatFetch } = loadUatSafety();
  assert.equal(typeof createUatFetch, 'function');
  const calls = [];
  let status = 200;
  const fetcher = createUatFetch(async (input, init) => {
    const request = new Request(input, init);
    calls.push({ url: request.url, method: request.method, authorization: request.headers.get('authorization'), redirect: request.redirect, body: await request.text() });
    return new Response(status === 200 ? '{}' : null, { status, headers: status === 200 ? {} : { Location: 'https://xtwlrjqbusadghavchqm.supabase.co/auth/v1/user' } });
  }, uatEnvironment());
  await fetcher(`${UAT_API_ORIGIN}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { authorization: 'Bearer SYNTHETIC_HEADER' }, body: 'synthetic-body' });
  assert.deepEqual(calls[0], { url: 'http://uat-gateway:8080/auth/v1/token?grant_type=password', method: 'POST', authorization: 'Bearer SYNTHETIC_HEADER', redirect: 'error', body: 'synthetic-body' });
  const request = new Request(`${UAT_API_ORIGIN}/rest/v1/rpc/performance_review_workspace`, { method: 'POST', headers: { authorization: 'Bearer SYNTHETIC_REQUEST' }, body: '{}' });
  await fetcher(request);
  assert.equal(calls[1].authorization, 'Bearer SYNTHETIC_REQUEST');
  assert.equal(calls[1].body, '{}');
  const denied = [
    'https://xtwlrjqbusadghavchqm.supabase.co/rest/v1/profiles',
    'https://kywdmxpmlualztgwfokg.supabase.co/rest/v1/profiles',
    'https://graph.microsoft.com/v1.0/me',
    'https://n8n.srv1866578.hstgr.cloud/webhook/anything',
    `${UAT_API_ORIGIN}/auth/v1/recover`, `${UAT_API_ORIGIN}/auth/v1/signup`,
    `${UAT_API_ORIGIN}/auth/v1/otp`, `${UAT_API_ORIGIN}/auth/v1/verify`,
    `${UAT_API_ORIGIN}/auth/v1/admin/users`, `${UAT_API_ORIGIN}/auth/v1/authorize`,
    `${UAT_API_ORIGIN}/auth/v1/token?grant_type=id_token`,
    `${UAT_API_ORIGIN}/unknown`, 'http://uat-gateway:8080/auth/v1/recover',
  ];
  for (const url of denied) await assert.rejects(() => fetcher(url, { method: 'POST' }), /UAT/);
  assert.equal(calls.length, 2);
  for (status of [301, 302, 303, 307, 308]) await assert.rejects(() => fetcher(`${UAT_API_ORIGIN}/auth/v1/user`), /UAT/);
  assert.equal(calls.length, 7);
  const ordinary = async () => new Response('ok');
  assert.equal(createUatFetch(ordinary, {}), ordinary);
});
