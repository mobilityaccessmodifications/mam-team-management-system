import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { Receiver } from './notification-workflow-harness.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');

export async function testDeliveredHistoryProducer(args, env) {
  const database = 'mam_test_delivered_producer';
  const original = args[args.indexOf('-d') + 1];
  const cloned = spawnSync('createdb', ['-h', args[args.indexOf('-h') + 1], '-p', args[args.indexOf('-p') + 1], '-U', 'postgres', `--template=${original}`, database], { env, encoding: 'utf8' });
  assert.equal(cloned.status, 0, cloned.stderr);
  const target = [...args]; target[target.indexOf('-d') + 1] = database;
  const sql = statement => {
    const result = spawnSync('psql', [...target, '-Atq'], { env, input: statement, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const output = sql(`begin;\n\\ir tests/confirmed-test-purge-delivered-fixture.sql\nselect 'MAM_FIXTURE|'||jsonb_build_object(
    'outbox',(select jsonb_agg(to_jsonb(q) order by id) from private.leave_notification_outbox q),
    'receipts',(select jsonb_agg(to_jsonb(r) order by event_key) from private.notification_delivery_receipts r))::text;\ncommit;`);
  const fixture = JSON.parse(output.split('\n').find(line => line.startsWith('MAM_FIXTURE|')).slice('MAM_FIXTURE|'.length));
  const receiver = new Receiver();
  const acknowledgements = [];
  const code = ts.transpileModule(readFileSync('src/lib/leave-notification-outbox.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const imports = {
    'server-only': {}, 'node:crypto': require('node:crypto'),
    '@/lib/supabase/admin': { createAdminClient: () => ({ rpc: async (name, input) => {
      if (name === 'claim_leave_notification_outbox') return { data: fixture.outbox.map(q => ({ delivery_id: q.id, claim_token: randomUUID(), payload: q.delivery_payload })), error: null };
      assert.equal(name, 'finish_leave_notification_outbox');
      acknowledgements.push(input);
      return { data: true, error: null };
    } }) },
  };
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(name in imports, `Unexpected dispatcher dependency ${name}`);
    return imports[name];
  }, loaded, loaded.exports);
  const savedFetch = globalThis.fetch;
  const keys = ['MAM_N8N_LEAVE_WEBHOOK_URL', 'MAM_N8N_LEAVE_WEBHOOK_ORIGIN', 'MAM_N8N_LEAVE_WEBHOOK_SECRET'];
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, { MAM_N8N_LEAVE_WEBHOOK_URL: 'https://example.test/synthetic-hook', MAM_N8N_LEAVE_WEBHOOK_ORIGIN: 'https://example.test', MAM_N8N_LEAVE_WEBHOOK_SECRET: 'synthetic-only' });
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), 'https://example.test/synthetic-hook');
      return Response.json(receiver.run(JSON.parse(options.body)));
    };
    assert.deepEqual(await loaded.exports.dispatchLeaveNotificationOutbox(), { ok: true, code: 'processed', claimed: 4, sent: 4, failed: 0 });
  } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  assert.equal(acknowledgements.length, 4);
  assert.ok(acknowledgements.every(a => a.p_delivered));
  assert.equal(receiver.api.rows.size, 6);
  for (const receipt of fixture.receipts) {
    const produced = receiver.api.rows.get(receipt.event_key);
    assert.equal(produced?.state, 'sent');
    assert.equal(receipt.recipient, produced.actualRecipient, 'SQL positive receipt To differs from actual dispatcher/validator');
    assert.equal(receipt.cc, produced.actualCcRecipients, 'SQL positive receipt CC differs from actual validator');
  }
  sql(`begin;\n\\ir tests/sql-test-auth.sql\nselect pg_temp.set_test_actor('91abcdef-0000-4000-8000-000000000001');
    create temp table producer_receipts_before as select to_jsonb(r) document from private.notification_delivery_receipts r;
    set local role authenticated;
    do $$ declare reviewed jsonb; begin
      reviewed:=public.preview_confirmed_test_identity_purge('91abcdef-0000-4000-8000-000000000002','91abcdef-0000-4000-8000-000000000002','mam','Delivered Fake Synthetic','delivered-fake@example.test',1,1);
      perform public.prepare_confirmed_test_identity_purge('91abcdef-0000-4000-8000-000000000002','91abcdef-0000-4000-8000-000000000002','mam','Delivered Fake Synthetic','delivered-fake@example.test',1,1,reviewed->>'manifest_hash',true,true);
    end $$;
    reset role;
    do $$ begin
      assert not exists(select 1 from public.leave_requests), 'Producer-positive purge left leave rows';
      assert (select count(*)=6 and bool_and(to_jsonb(r)=b.document) from private.notification_delivery_receipts r join producer_receipts_before b on r.event_key=b.document->>'event_key'), 'Producer-positive purge rewrote no-resend envelopes';
    end $$; rollback;`);
  console.log('PASS actual dispatcher + reviewed n8n graph produce all six exact fixture To/CC/key envelopes; full-schema preview/prepare preserves every original no-resend row');
}
