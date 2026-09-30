import test from 'node:test';
import assert from 'node:assert/strict';
import { runRecovery } from '../scripts/recover-background-jobs.mjs';

test('a failed recovery worker cannot prevent both Check-In workers from running', async () => {
  const called = [];
  const errors = [];
  const ok = await runRecovery('synthetic-secret', async (url) => {
    const job = new URL(url).searchParams.get('job');
    called.push(job);
    if (job === 'leave-notifications') throw new Error('synthetic outage');
    return Response.json({ ok: true });
  }, { log() {}, error(message) { errors.push(message); } });
  assert.equal(ok, false);
  assert.ok(called.includes('check-in-reminders'));
  assert.ok(called.includes('new-starter-day-one'));
  assert.ok(called.includes('onboarding-credentials'));
  assert.ok(called.includes('scheduled-offboarding'));
  assert.deepEqual(errors, ['leave-notifications: dispatcher unavailable.']);
});
