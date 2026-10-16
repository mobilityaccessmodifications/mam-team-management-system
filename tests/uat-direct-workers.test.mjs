import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './helpers/contact-lifetime-harness.mjs';

test('direct UAT attachment maintenance rejects before admin, claims, pruning or Storage', async () => {
  const previous = process.env.MAM_UAT_ENABLED;
  const calls = [];
  const worker = loadModule('src/lib/leave-attachment-maintenance.ts', {
    '@/lib/supabase/admin': { createAdminClient() {
      calls.push('admin');
      return { rpc: async name => { calls.push(name); return { data: name.startsWith('prune_') ? 0 : [], error: null }; } };
    } },
  });
  try {
    process.env.MAM_UAT_ENABLED = 'true';
    await assert.rejects(() => worker.runLeaveAttachmentMaintenance(), /UAT/);
    assert.deepEqual(calls, []);
    process.env.MAM_UAT_ENABLED = 'false';
    const result = await worker.runLeaveAttachmentMaintenance();
    assert.equal(calls.filter(name => name === 'admin').length, 1);
    assert.equal(result.removedObjects, 0);
    assert.ok(calls.includes('prune_expired_leave_attachment_upload_intents'));
    assert.ok(calls.includes('prune_expired_leave_attachment_upload_attempts'));
  } finally {
    if (previous === undefined) delete process.env.MAM_UAT_ENABLED;
    else process.env.MAM_UAT_ENABLED = previous;
  }
});
