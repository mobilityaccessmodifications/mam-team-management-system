import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, form, ok, PASSWORD, PERSON, UNAVAILABLE, USER } from './uat-effects-fixtures.mjs';

const path = 'src/app/login/forgot-password/actions.ts';
const resetInput = { token: 'A'.repeat(43), password: PASSWORD, confirmPassword: PASSWORD };
const unavailable = { status: 'error', message: 'Password reset is unavailable. Try again later.' };

for (const [name, input] of [['requestPasswordRecovery', { email: 'synthetic@example.invalid' }], ['resetRecoveredPassword', resetInput]]) {
  test(`UAT actual ${name} returns typed unavailable before privileged ports`, async () => {
    const f = fixture();
    try {
      const actions = await f.load(path);
      const result = await actions[name]({}, form(input));
      f.observe(name, result);
      f.assertZero(name);
      assert.deepEqual(result, unavailable);
      await f.flush();
      f.assertZero(name + ' after flush');
    } finally { f.cleanup(); }
  });
}

test('recovery retains original validation and serializable typed errors in UAT', async () => {
  const f = fixture();
  try {
    const actions = await f.load(path);
    assert.deepEqual(await actions.requestPasswordRecovery({}, form({ email: 'not-email' })), { status: 'error', message: 'Enter a valid email address.' });
    const token = await actions.resetRecoveredPassword({}, form({ ...resetInput, token: 'bad' }));
    const password = await actions.resetRecoveredPassword({}, form({ ...resetInput, password: 'short' }));
    const mismatch = await actions.resetRecoveredPassword({}, form({ ...resetInput, confirmPassword: 'different' }));
    assert.match(token.message, /invalid|expired/i);
    assert.match(password.message, /12|characters/i);
    assert.equal(mismatch.message, 'The passwords do not match.');
    for (const value of [token, password, mismatch]) { assert.equal(value.status, 'error'); assert.deepEqual(JSON.parse(JSON.stringify(value)), value); }
    f.assertZero('validation');
  } finally { f.cleanup(); }
});

function recoveryFixture() {
  const seen = [];
  const admin = { rpc: async (name, args) => {
    seen.push(name);
    if (name === 'claim_portal_login_attempt') return ok(true);
    if (name === 'issue_portal_password_recovery') return ok([{ request_id: PERSON, recipient: args.p_email }]);
    if (name === 'begin_portal_password_recovery') return ok([{ auth_user_id: USER, reset_token: PERSON }]);
    if (name === 'finish_portal_password_recovery') return ok(true);
    throw new Error('Unexpected synthetic RPC: ' + name);
  }, auth: { admin: { updateUserById: async id => { seen.push('provider.password'); return ok({ user: { id } }); } } } };
  const f = fixture({ uat: false, admin, ports: {
    headers: () => new Headers({ 'x-real-ip': '192.0.2.2' }),
    randomBytes: size => Buffer.alloc(size, 1),
    after: () => undefined,
    redirect: url => { throw new Error('Synthetic redirect:' + url); },
    'provider.fetch': async (_url, init) => { const payload = JSON.parse(init.body); return Response.json({ ok: true, sent: true, requestId: payload.requestId }); },
  } });
  return { f, seen };
}

test('ordinary recovery retains claim and deferred delivery rather than fake success', async () => {
  const { f, seen } = recoveryFixture();
  try {
    const actions = await f.load(path);
    const result = await actions.requestPasswordRecovery({}, form({ email: 'synthetic@example.invalid' }));
    assert.equal(result.status, 'success');
    assert.equal(f.callbacks.length, 1);
    assert.deepEqual(seen, ['claim_portal_login_attempt', 'issue_portal_password_recovery']);
    assert.equal(f.calls.includes('provider.fetch'), false);
    await f.flush();
    assert.equal(f.calls.filter(name => name === 'provider.fetch').length, 1);
  } finally { f.cleanup(); }
});

test('already scheduled recovery after callback rechecks UAT before sending', async () => {
  const { f } = recoveryFixture();
  try {
    const actions = await f.load(path);
    await actions.requestPasswordRecovery({}, form({ email: 'synthetic@example.invalid' }));
    assert.equal(f.callbacks.length, 1);
    process.env.MAM_UAT_ENABLED = 'true';
    f.calls.splice(0);
    await f.flush();
    f.observe('recovery after UAT enabled', {});
    f.assertZero('recovery after UAT enabled');
  } finally { f.cleanup(); }
});

test('ordinary password reset retains claim -> provider -> finalisation and redirect', async () => {
  const { f, seen } = recoveryFixture();
  try {
    const actions = await f.load(path);
    await assert.rejects(actions.resetRecoveredPassword({}, form(resetInput)), /Synthetic redirect:\/login\?password=reset/);
    assert.deepEqual(seen, ['begin_portal_password_recovery', 'provider.password', 'finish_portal_password_recovery']);
  } finally { f.cleanup(); }
});

for (const uat of [true, false]) {
  test(`${uat ? 'UAT' : 'ordinary'} actual Auth confirmation ${uat ? 'rejects without OTP' : 'retains OTP and safe redirect'}`, async () => {
    const f = fixture({ uat, client: { auth: { verifyOtp: (...args) => f.hit('auth.verifyOtp', ...args) } }, ports: {
      'auth.verifyOtp': async () => ({ error: null }),
      redirect: url => { throw new Error('Synthetic redirect:' + url); },
    } });
    try {
      const { GET } = await f.load('src/app/auth/confirm/route.ts');
      const request = new Request('https://app.example.invalid/auth/confirm?token_hash=synthetic&type=recovery&next=/');
      request.nextUrl = new URL(request.url);
      if (uat) {
        let response;
        let thrown;
        try { response = await GET(request); } catch (error) { thrown = error; }
        f.observe('confirm', { status: response?.status, threw: Boolean(thrown) });
        f.assertZero('confirm');
        assert.equal(thrown, undefined);
        assert.equal(response.status, 403);
        assert.deepEqual(await response.json(), { error: UNAVAILABLE });
      } else {
        await assert.rejects(GET(request), /Synthetic redirect:\/$/);
        assert.deepEqual(f.calls, ['client', 'auth.verifyOtp', 'redirect']);
      }
    } finally { f.cleanup(); }
  });
}

test('UAT actual native password sign-in and sign-out keep the service-only login RPCs', async () => {
  const rpc = [];
  const auth = [];
  const f = fixture({ admin: { rpc: async name => {
    rpc.push(name);
    if (name === 'claim_portal_login_attempt' || name === 'clear_portal_login_rate_limit') return ok(true);
    if (name === 'resolve_portal_login_auth_email') return ok('synthetic-auth@example.invalid');
    throw new Error(name);
  } }, client: {
    auth: {
      signInWithPassword: async () => { auth.push('password'); return ok({ user: { id: USER }, session: { access_token: 'synthetic' } }); },
      signOut: async options => { assert.deepEqual(options, { scope: 'local' }); auth.push('signout'); return { error: null }; },
    },
    rpc: async name => { rpc.push(name); assert.equal(name, 'current_portal_account'); return ok([{ account_status: 'active' }]); },
  }, ports: { headers: () => new Headers(), redirect: url => { throw new Error('Synthetic redirect:' + url); } } });
  try {
    const actions = await f.load('src/app/login/actions.ts', { '@/lib/supabase/config': 'export const isSupabaseConfigured = () => true;' });
    await assert.rejects(actions.signIn({}, form({ username: 'synthetic@example.invalid', password: PASSWORD })), /Synthetic redirect:\/$/);
    assert.deepEqual(rpc, ['claim_portal_login_attempt', 'resolve_portal_login_auth_email', 'current_portal_account', 'clear_portal_login_rate_limit']);
    assert.deepEqual(await actions.signOut(), { signedOut: true });
    assert.deepEqual(auth, ['password', 'signout']);
  } finally { f.cleanup(); }
});
