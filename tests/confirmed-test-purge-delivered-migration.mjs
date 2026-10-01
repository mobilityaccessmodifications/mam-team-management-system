import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

export function testDeliveredHistoryMigration(args, env, source) {
  const original = args[args.indexOf('-d') + 1];
  const run = (statement, database = original, succeeds = true) => {
    const target = [...args]; target[target.indexOf('-d') + 1] = database;
    const result = spawnSync('psql', [...target, '-Atq'], { env, input: statement, encoding: 'utf8' });
    if (succeeds) assert.equal(result.status, 0, result.stderr);
    else assert.notEqual(result.status, 0, 'Unsafe forward migration succeeded');
    return succeeds ? result.stdout.trim() : result.stderr;
  };
  const clone = (name) => {
    const result = spawnSync('createdb', ['-h', args[args.indexOf('-h') + 1], '-p', args[args.indexOf('-p') + 1], '-U', 'postgres', `--template=${original}`, name], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return name;
  };
  const snapshot = `select jsonb_build_object('stored',(select schema_hash from private.confirmed_test_purge_schema),
    'bodies',(select jsonb_object_agg(p.oid::regprocedure::text,md5(p.prosrc)) from pg_proc p where p.proname in
      ('confirmed_test_purge_census','prepare_confirmed_test_identity_purge','reject_retired_test_identity_reference','complete_confirmed_test_identity_purge','confirmed_test_purge_schema_hash')),
    'helper',to_regprocedure('private.confirmed_test_retained_leave_receipt(jsonb)'));`;
  const originalSnapshot = run(snapshot);
  const drifts = [
    'alter table private.leave_submission_receipts add column synthetic_unreviewed text;',
    'grant execute on function public.get_confirmed_test_identity_purge(uuid) to service_role;',
    'create trigger synthetic_unreviewed before delete on private.leave_notification_outbox for each row execute function private.protect_pending_leave_notifications();',
  ];
  for (const [index, drift] of drifts.entries()) {
    const database = clone(`mam_test_delivered_drift_${index}`);
    run(drift, database);
    const before = run(snapshot, database);
    assert.match(run(source, database, false), /drift requires independent review/);
    assert.equal(run(snapshot, database), before, 'Failed guard changed functions/fingerprint');
  }
  console.log('PASS forward migration rejects pre-existing column, ACL and trigger drift without resetting the fingerprint');
  for (const [index, fault] of [
    "do $$ begin raise exception 'synthetic atomic rollback'; end $$;",
    'alter table private.leave_submission_receipts add column synthetic_race text;',
    'grant execute on function public.get_confirmed_test_identity_purge(uuid) to service_role;',
    "create or replace function private.confirmed_test_retained_leave_receipt(p_document jsonb) returns boolean language sql stable security definer set search_path='' as $$ select true $$;",
    "alter function private.confirmed_test_retained_leave_receipt(jsonb) reset all;",
    "grant execute on function private.confirmed_test_retained_leave_receipt(jsonb) to service_role;",
    source.match(/create or replace function private\.confirmed_test_purge_census\(.*?\$\$;/s)[0].replace('begin\n', 'begin\n  perform 1;\n'),
  ].entries()) {
    const database = clone(`mam_test_delivered_atomic_${index}`);
    const mutated = index === 0 ? source.replace(/\ncommit;\s*$/, () => `\n${fault}\ncommit;\n`)
      : source.replace('\ndo $guard$ declare query text;', () => `\n${fault}\ndo $guard$ declare query text;`);
    assert.notEqual(mutated, source);
    assert.match(run(mutated, database, false), index === 0 ? /ERROR:  synthetic atomic rollback/ : /(?:Unreviewed schema change|Reviewed function definition\/owner\/ACL drift) during forward correction/);
    assert.equal(run(snapshot, database), originalSnapshot, 'Forward failure was not atomic');
    assert.equal(run('select private.confirmed_test_purge_schema_hash()=(select schema_hash from private.confirmed_test_purge_schema);', database), 't');
  }
  console.log('PASS induced post-write failure and intra-migration column/ACL changes roll back every delta and fingerprint update');
  const lateDatabase = clone('mam_test_delivered_late_drift');
  const updateAnchor = '  update private.confirmed_test_purge_schema set schema_hash=';
  const lateSource = source.replace(updateAnchor, `  alter table private.leave_submission_receipts add column synthetic_late_race text;\n${updateAnchor}`);
  assert.notEqual(lateSource, source);
  run(lateSource, lateDatabase);
  assert.equal(run('select private.confirmed_test_purge_schema_hash()<>(select schema_hash from private.confirmed_test_purge_schema);', lateDatabase), 't', 'Late unreviewed catalog drift was silently included in the new fingerprint');
  console.log('PASS schema drift after final comparison cannot be consumed by the reviewed fingerprint transition');
  const database = clone('mam_test_delivered_apply');
  run(`insert into private.confirmed_test_identity_purges(person_id,actor_user_id,company_key,manifest_hash,manifest,retained_audit,retired_identifiers,phase,completed_at)
    values('90abcdef-0000-4000-8000-000000000099','90abcdef-0000-4000-8000-000000000001','mam',repeat('a',64),'{}','{}',array['90abcdef-0000-4000-8000-000000000099']::uuid[],'complete',clock_timestamp());`, database);
  const priorReceipt = run('select to_jsonb(p) from private.confirmed_test_identity_purges p;', database);
  const priorTriggers = run("select jsonb_agg(jsonb_build_array(tgrelid::regclass::text,tgname,tgenabled,pg_get_triggerdef(oid)) order by tgrelid,tgname) from pg_trigger where not tgisinternal;", database);
  run(source, database);
  assert.equal(run('select to_jsonb(p) from private.confirmed_test_identity_purges p;', database), priorReceipt, 'Earlier completed receipt was rewritten');
  assert.equal(run("select jsonb_agg(jsonb_build_array(tgrelid::regclass::text,tgname,tgenabled,pg_get_triggerdef(oid)) order by tgrelid,tgname) from pg_trigger where not tgisinternal;", database), priorTriggers, 'Forward migration changed/disabled source triggers');
  assert.equal(run('select private.confirmed_test_purge_schema_hash()=(select schema_hash from private.confirmed_test_purge_schema);', database), 't');
  assert.equal(run("select not has_function_privilege('anon','private.confirmed_test_retained_leave_receipt(jsonb)','EXECUTE') and not has_function_privilege('authenticated','private.confirmed_test_retained_leave_receipt(jsonb)','EXECUTE') and not has_function_privilege('service_role','private.confirmed_test_retained_leave_receipt(jsonb)','EXECUTE');", database), 't');
  const applied = run(snapshot, database);
  assert.match(run(source, database, false), /Exact purge function predecessor required/);
  assert.equal(run(snapshot, database), applied, 'Repeat migration changed recorded candidate');
  console.log('PASS exact forward apply preserves earlier completed receipts/triggers, advances only reviewed fingerprint delta and rejects replay');
}
