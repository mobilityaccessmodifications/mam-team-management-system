import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './helpers/unified-role-harness.mjs';

const taskId = '33000000-0000-4000-8000-000000000001';
const previewPersonId = '33000000-0000-4000-8000-000000000002';
const checkIn = { kind: 'check_in', taskId };
const subscription = { kind: 'subscription_review', taskId, reviewOn: '2026-10-14' };
const schedule = { kind: 'work_schedule', taskId };

function harness({ data = { text: 'Synthetic follow-up', version: 1 }, error = null, session = true, authError = null, throws = false } = {}) {
  const calls = [], events = [];
  const client = {
    auth: { getUser: async () => { events.push('auth'); return { data: { user: session ? { id: taskId } : null }, error: authError }; } },
    rpc: async (name, args) => { events.push('rpc'); calls.push({ name, args }); if (throws) throw new Error('synthetic private detail'); return { data, error }; },
  };
  const actions = loadModule('src/app/tasks/note-actions.ts', { '@/lib/supabase/server': { createClient: async () => client } });
  return { ...actions, calls, events };
}

for (const target of [checkIn, subscription, schedule]) {
  test(`notes read reauthenticates and sends the precise ${target.kind} identity`, async () => {
    const h = harness();
    assert.deepEqual(await h.getTaskNotes(target), { ok: true, notes: { text: 'Synthetic follow-up', version: 1 } });
    assert.deepEqual(h.events, ['auth', 'rpc']);
    assert.deepEqual(h.calls, [{ name: 'get_visible_task_notes', args: {
      p_kind: target.kind, p_task_id: taskId, p_review_on: target.reviewOn ?? null, p_preview_person_id: null,
    } }]);
  });
  test(`notes save uses a separate ${target.kind} compare-and-swap version`, async () => {
    const h = harness();
    assert.deepEqual(await h.saveTaskNotes({ target, text: 'Synthetic follow-up', version: 0 }), { ok: true, notes: { text: 'Synthetic follow-up', version: 1 } });
    assert.deepEqual(h.events, ['auth', 'rpc']);
    assert.deepEqual(h.calls, [{ name: 'save_visible_task_notes', args: {
      p_kind: target.kind, p_task_id: taskId, p_review_on: target.reviewOn ?? null, p_text: 'Synthetic follow-up', p_expected_version: 0,
    } }]);
  });
}

test('notes preview sends only the controlled selected-person read parameter', async () => {
  const h = harness();
  assert.equal((await h.getTaskNotes(subscription, previewPersonId)).ok, true);
  assert.equal(h.calls[0].args.p_preview_person_id, previewPersonId);
  assert.equal((await h.saveTaskNotes({ target: subscription, text: '', version: 0, previewPersonId })).ok, false);
  assert.equal(h.calls.length, 1);
});

for (const target of [null, [], {}, { ...checkIn, kind: 'other' }, { ...checkIn, taskId: 'invalid' },
  { ...subscription, reviewOn: '2026-02-30' }, { ...subscription, reviewOn: undefined },
  { ...checkIn, reviewOn: '2026-10-14' }, { ...schedule, reviewOn: '2026-10-14' }]) {
  test(`invalid notes target is rejected before authentication ${JSON.stringify(target)}`, async () => {
    const h = harness();
    assert.equal((await h.getTaskNotes(target)).ok, false);
    assert.equal((await h.saveTaskNotes({ target, text: '', version: 0 })).ok, false);
    assert.deepEqual(h.events, []);
  });
}

for (const input of [{ text: 'x'.repeat(5001) }, { text: 'nul\0text' }, { text: null },
  { version: -1 }, { version: 0.5 }, { version: Number.MAX_SAFE_INTEGER }, { previewPersonId: null }]) {
  test(`invalid notes save is rejected before any write ${JSON.stringify(input).slice(0, 50)}`, async () => {
    const h = harness();
    assert.equal((await h.saveTaskNotes({ target: checkIn, text: '', version: 0, ...input })).ok, false);
    assert.deepEqual(h.events, []);
  });
}

test('empty notes and the 5,000-character boundary are valid saves', async () => {
  for (const text of ['', 'x'.repeat(5000)]) {
    const h = harness({ data: { text, version: 2 } });
    assert.deepEqual(await h.saveTaskNotes({ target: checkIn, text, version: 1 }), { ok: true, notes: { text, version: 2 } });
  }
});

for (const options of [{ session: false }, { authError: { message: 'private auth detail' } }]) {
  test('notes read and save reject an unavailable authenticated session', async () => {
    const h = harness(options);
    assert.equal((await h.getTaskNotes(checkIn)).ok, false);
    assert.equal((await h.saveTaskNotes({ target: checkIn, text: '', version: 0 })).ok, false);
    assert.deepEqual(h.calls, []);
  });
}

for (const code of ['42501', '40001', '22023', 'XX000']) {
  test(`provider ${code} errors remain safe serializable notes errors`, async () => {
    const h = harness({ error: { code, message: 'synthetic private detail' } });
    for (const result of [await h.getTaskNotes(checkIn), await h.saveTaskNotes({ target: checkIn, text: '', version: 0 })]) {
      assert.equal(result.ok, false);
      assert.doesNotMatch(JSON.stringify(result), /private detail/);
      if (code === '40001') assert.match(result.error, /notes have changed/);
    }
  });
}

test('provider exceptions are bounded and do not expose notes or provider details', async () => {
  const h = harness({ throws: true });
  assert.deepEqual(await h.getTaskNotes(checkIn), { ok: false, error: 'Task notes could not be loaded. Refresh and try again.' });
  assert.deepEqual(await h.saveTaskNotes({ target: checkIn, text: '', version: 0 }), { ok: false, error: 'Task notes could not be saved. Refresh and try again.' });
});

for (const data of [null, [], { text: 12, version: 0 }, { text: '', version: -1 }, { text: '', version: '1' }]) {
  test('malformed notes response cannot enter the notes editor', async () => {
    const h = harness({ data });
    assert.equal((await h.getTaskNotes(checkIn)).ok, false);
  });
}

test('an acknowledged notes write remains acknowledged after an invalid return projection', async () => {
  const h = harness({ data: null });
  assert.deepEqual(await h.saveTaskNotes({ target: checkIn, text: 'Synthetic follow-up', version: 0 }), {
    ok: true, notes: { text: 'Synthetic follow-up', version: 1 },
  });
});
