import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import test from 'node:test';
import { reviewActionHarness as harness, deliveryId, updatedAt, rowFixture } from './helpers/onboarding-review-action-harness.mjs';
const require = createRequire(import.meta.url);

test('credential review denies unauthenticated and non-System Admin actors before reading or cancelling', async () => {
  for (const config of [{ signedIn: false }, { permitted: false }]) {
    const { actions, calls } = harness(config);
    const result = await actions.cancelOnboardingCredentialReview({ deliveryId, updatedAt });
    assert.equal(result.ok, false);
    assert.equal(calls.some((call) => call.name === 'cancel_onboarding_credential_review'), false);
    const read = await actions.listOnboardingCredentialReviews();
    assert.equal(read.ok, false);
    assert.equal(calls.some((call) => call.name === 'list_onboarding_credential_reviews'), false);
  }
});

test('credential review cancellation uses only the authenticated RPC and preserves timestamp precision', async () => {
  const { actions, calls } = harness();
  assert.equal((await actions.cancelOnboardingCredentialReview({ deliveryId, updatedAt })).ok, true);
  assert.deepEqual(calls.filter((call) => call.name === 'cancel_onboarding_credential_review'), [{ name: 'cancel_onboarding_credential_review', args: { p_delivery_id: deliveryId, p_expected_updated_at: updatedAt } }]);
});

test('invalid inputs do not dispatch cancellation', async () => {
  for (const input of [{ deliveryId: 'invalid', updatedAt }, { deliveryId, updatedAt: '' }, { deliveryId, updatedAt: 'not-a-date' }, null]) {
    const { actions, calls } = harness();
    const result = await actions.cancelOnboardingCredentialReview(input);
    assert.equal(result.ok, false);
    assert.equal(calls.some((call) => call.name === 'cancel_onboarding_credential_review'), false);
  }
});

test('stale cancellation is an actionable serializable rejection without provider details', async () => {
  const { actions } = harness({ dbError: { code: '55000', message: 'synthetic private database detail' } });
  const result = await actions.cancelOnboardingCredentialReview({ deliveryId, updatedAt });
  assert.equal(result.ok, false);
  assert.match(result.message, /refresh|changed|review/i);
  assert.doesNotMatch(JSON.stringify(result), /synthetic private|digest|claim_token|password/);
});

test('a successful cancellation remains committed when cache invalidation fails', async () => {
  const { actions } = harness({ revalidateError: true });
  const result = await actions.cancelOnboardingCredentialReview({ deliveryId, updatedAt });
  assert.equal(result.ok, true);
  assert.equal(result.committed, true);
});

test('safe list DTO excludes extra credential, contact and provider fields while preserving all timestamp bytes', async () => {
  const raw = { ...rowFixture, updated_at: '2026-10-01T15:00:00.123456+10:00', claimed_login: 'private@example.test', password: 'synthetic-private', claim_token: 'synthetic-token', provider_receipt: { private: true } };
  const { actions, calls } = harness({ rows: [raw] });
  const result = await actions.listOnboardingCredentialReviews();
  assert.equal(result.ok, true);
  assert.deepEqual(result.reviews, [{ deliveryId, employeeName: 'Synthetic Starter', company: 'mam', status: 'needs_review', reviewCode: 'delivery_uncertain', hasClaimedLogin: true, dueDate: '2026-10-01', createdAt: updatedAt, updatedAt: raw.updated_at }]);
  assert.doesNotMatch(JSON.stringify(result), /private@example|synthetic-private|synthetic-token|provider_receipt|password|claim_token/);
  assert.deepEqual(calls.map(c => c.name), ['can_change_employee_view', 'list_onboarding_credential_reviews']);
});

test('authority and malformed response failures never become an empty successful list', async () => {
  for (const config of [{ authError: new Error('synthetic private auth') }, { permissionError: { message: 'synthetic private authority' } }, { permitted: 'true' }]) {
    const { actions, calls } = harness(config);
    assert.equal((await actions.listOnboardingCredentialReviews()).ok, false);
    assert.equal((await actions.cancelOnboardingCredentialReview({ deliveryId, updatedAt })).ok, false);
    assert.ok(!calls.some(c => c.name === 'list_onboarding_credential_reviews' || c.name === 'cancel_onboarding_credential_review'));
  }
  for (const rows of [null, {}, [null], [{ ...rowFixture, has_claimed_login: 'true' }], [{ ...rowFixture, status: 'sending' }], [{ ...rowFixture, updated_at: 'invalid' }]]) {
    const { actions } = harness({ rows });
    assert.equal((await actions.listOnboardingCredentialReviews()).ok, false);
  }
});

test('transport, database and false-ack cancellation failures are sanitized and never retried', async () => {
  for (const config of [{ transportError: new Error('synthetic private provider token') }, { dbError: { code: 'XX000', message: 'synthetic private SQL' } }, { cancelled: false }]) {
    const { actions, calls } = harness(config);
    const result = await actions.cancelOnboardingCredentialReview({ deliveryId, updatedAt });
    assert.equal(result.ok, false);
    assert.match(result.message, /refresh/i);
    assert.doesNotMatch(JSON.stringify(result), /synthetic private|SQL|provider|token/);
    assert.equal(calls.filter(c => c.name === 'cancel_onboarding_credential_review').length, 1);
  }
});

test('production Flight transports actual safe action results, including the acknowledged commit warning', async () => {
  const script = `import {createRequire} from 'node:module';
    import {reviewActionHarness as fixture,deliveryId,updatedAt,rowFixture} from './tests/helpers/onboarding-review-action-harness.mjs';
    const require=createRequire(import.meta.url), input={deliveryId,updatedAt};
    require('next/dist/compiled/react-server-dom-webpack/server.node').renderToPipeableStream({
      stale:fixture({dbError:{code:'55000',message:'synthetic private detail'}}).actions.cancelOnboardingCredentialReview(input),
      denied:fixture({permitted:false}).actions.listOnboardingCredentialReviews(),
      unknown:fixture({transportError:new Error('synthetic private provider')}).actions.cancelOnboardingCredentialReview(input),
      committed:fixture({revalidateError:true}).actions.cancelOnboardingCredentialReview(input),
      list:fixture({rows:[rowFixture]}).actions.listOnboardingCredentialReviews(),
    },{}, {onError:()=> 'synthetic-digest'}).pipe(process.stdout);`;
  const encoded = spawnSync(process.execPath, ['--conditions=react-server', '--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' } });
  assert.equal(encoded.status, 0, encoded.stderr);
  const { createFromNodeStream } = require('next/dist/compiled/react-server-dom-webpack/cjs/react-server-dom-webpack-client.node.production.js');
  const decoded = await createFromNodeStream(Readable.from([encoded.stdout]), { moduleMap: {}, serverModuleMap: {}, moduleLoading: null });
  for (const key of ['stale', 'denied', 'unknown']) assert.equal((await decoded[key]).ok, false);
  assert.equal((await decoded.committed).committed, true);
  assert.equal((await decoded.list).reviews[0].updatedAt, updatedAt);
  assert.doesNotMatch(encoded.stdout, /synthetic private|synthetic-digest|:E\{/);
});
