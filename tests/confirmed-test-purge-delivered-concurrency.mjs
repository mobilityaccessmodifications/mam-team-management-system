import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';

export async function testDeliveredHistoryConcurrency(args, env, { databaseCreator = 'postgres' } = {}) {
  const original = args[args.indexOf('-d') + 1];
  const query = (target, statement) => {
    const result = spawnSync('psql', [...target, '-Atq'], { env, input: statement, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  const launch = (target, statement) => {
    const child = spawn('psql', [...target, '-Atq'], { env }); let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data); child.stdin.end(statement);
    return new Promise((resolve, reject) => { child.on('error', reject); child.on('close', status => resolve({ status, stdout, stderr })); });
  };
  const actor = "do $$ begin perform set_config('request.jwt.claims',jsonb_build_object('sub','91abcdef-0000-4000-8000-000000000001','role','authenticated','iat',extract(epoch from now())::bigint,'is_anonymous',false)::text,false); end $$;";
  const identity = "'91abcdef-0000-4000-8000-000000000002','91abcdef-0000-4000-8000-000000000002','mam','Delivered Fake Synthetic','delivered-fake@example.test',1,1";
  const setup = (suffix) => {
    const database = `mam_test_delivered_race_${suffix}`;
    const created = spawnSync('createdb', ['-h', args[args.indexOf('-h') + 1], '-p', args[args.indexOf('-p') + 1], '-U', databaseCreator, `--template=${original}`, database], { env, encoding: 'utf8' });
    assert.equal(created.status, 0, created.stderr);
    const target = [...args]; target[target.indexOf('-d') + 1] = database;
    const fixture = spawnSync('psql', [...target, '-f', 'tests/confirmed-test-purge-delivered-fixture.sql'], { env, encoding: 'utf8' });
    assert.equal(fixture.status, 0, fixture.stderr);
    const hash = query(target, `${actor} select public.preview_confirmed_test_identity_purge(${identity})->>'manifest_hash';`);
    return { target, prepare: `${actor} set role authenticated; select public.prepare_confirmed_test_identity_purge(${identity},'${hash}',true,true);` };
  };
  const sleeping = async (target, name) => {
    for (let n = 0; n < 100; n++) {
      if (query(target, `select count(*) from pg_stat_activity where application_name='${name}' and wait_event='PgSleep';`) === '1') return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Synthetic writer did not acquire ${name}`);
  };
  for (const [index, relation] of ['leave_notification_outbox', 'notification_delivery_receipts', 'leave_submission_receipts', 'portal_account_status_change_claims'].entries()) {
    const { target, prepare } = setup(`row_${index}`);
    const writer = launch(target, `set application_name='delivered-reverse-${index}'; begin; select 1 from private.${relation} for update; select pg_sleep(0.8); update auth.users set raw_user_meta_data='{}' where id='91abcdef-0000-4000-8000-000000000001'; commit;`);
    await sleeping(target, `delivered-reverse-${index}`);
    const started = Date.now(); const purge = await launch(target, prepare); const elapsed = Date.now() - started;
    const normal = await writer;
    assert.equal(normal.status, 0, normal.stderr); assert.notEqual(purge.status, 0); assert.match(purge.stderr, /could not obtain lock/);
    assert.ok(elapsed < 500, `Purge waited ${elapsed}ms for ${relation}`);
    assert.equal(query(target, "select count(*) from public.internal_org_people where id='91abcdef-0000-4000-8000-000000000002';"), '1');
    assert.equal(query(target, "select count(*) from private.confirmed_test_identity_purges where person_id='91abcdef-0000-4000-8000-000000000002';"), '0');
  }
  console.log('PASS delivered outbox, retained receipt, submission and status-claim reverse-order row writers survive fail-fast purge');
  {
    const { target, prepare } = setup('retention_first');
    const worker = launch(target, "set application_name='delivered-retention-first'; begin; select private.minimize_notification_delivery_receipts('{}',1000); select pg_sleep(0.8); commit;");
    await sleeping(target, 'delivered-retention-first');
    const purge = await launch(target, prepare); const retained = await worker;
    assert.equal(retained.status, 0, retained.stderr); assert.match(retained.stdout, /6/);
    assert.notEqual(purge.status, 0); assert.match(purge.stderr, /could not obtain lock/);
    assert.equal(query(target, "select count(*) from private.notification_delivery_receipts where state='sent_tombstone';"), '6');
    assert.equal(query(target, "select count(*) from private.confirmed_test_identity_purges where person_id='91abcdef-0000-4000-8000-000000000002';"), '0');
    assert.equal(query(target, "select count(*) from public.internal_org_people where id='91abcdef-0000-4000-8000-000000000002';"), '1');
  }
  console.log('PASS actual retention-first transaction wins without losing no-resend keys; stale purge loses without business destruction');
  {
    const { target, prepare } = setup('purge_first');
    const purge = launch(target, `set application_name='delivered-purge-first'; begin; ${prepare} select pg_sleep(0.8); commit;`);
    await sleeping(target, 'delivered-purge-first');
    const worker = launch(target, "set statement_timeout='3s'; select private.minimize_notification_delivery_receipts('{}',1000);");
    const [prepared, retained] = await Promise.all([purge, worker]);
    assert.equal(prepared.status, 0, prepared.stderr); assert.equal(retained.status, 0, retained.stderr); assert.match(retained.stdout, /6/);
    assert.equal(query(target, "select count(*) from private.notification_delivery_receipts where state='sent_tombstone' and private.confirmed_test_retained_leave_receipt(to_jsonb(notification_delivery_receipts));"), '6');
    assert.equal(query(target, "select count(*) from public.internal_org_people where id='91abcdef-0000-4000-8000-000000000002';"), '0');
    assert.equal(query(target, "select count(*) from private.leave_notification_outbox;"), '0');
    assert.equal(query(target, "select count(*) from private.confirmed_test_identity_purges where person_id='91abcdef-0000-4000-8000-000000000002' and phase='business_purged';"), '1');
  }
  console.log('PASS purge-first commit allows queued real 90-day minimization using exact retained audit, with no resend/history recreation');
}
