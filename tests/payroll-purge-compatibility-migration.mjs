import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

export function testCompatibilityMigration({ source, clone, run, catalog, snapshot }) {
  let cases = 0;
  const reject = (database, mutated, expected) => {
    const beforeCatalog = catalog(database);
    const before = snapshot(database);
    const result = run(database, mutated);
    assert.notEqual(result.status, 0, `Unsafe payroll migration succeeded (${database})`);
    assert.match(result.stderr, expected);
    assert.deepEqual(catalog(database), beforeCatalog, 'Rejected migration changed the exact protected catalog');
    assert.equal(snapshot(database), before, 'Rejected migration changed guard, receipts or privilege metadata');
    cases++;
  };
  for (const [index, drift] of [
    'delete from private.confirmed_test_purge_schema;',
    "update private.confirmed_test_purge_schema set schema_hash=repeat('0',64);",
    'alter table private.employee_annual_leave_balances add column compatibility_unreviewed text;',
    'grant execute on function public.get_confirmed_test_identity_purge(uuid) to service_role;',
    'create trigger compatibility_unreviewed before delete on public.leave_requests for each row execute function private.reject_retired_test_identity_reference();',
    "create function private.compatibility_unreviewed() returns integer language sql as $$select 1$$;",
    "alter function private.confirmed_test_purge_schema_hash() security invoker; update private.confirmed_test_purge_schema set schema_hash=private.confirmed_test_purge_schema_hash();",
    "alter table private.confirmed_test_purge_schema drop constraint confirmed_test_purge_schema_singleton_check; insert into private.confirmed_test_purge_schema values(false,repeat('0',64));",
  ].entries()) {
    const database = clone(`mam_test_compat_pre_${index}`);
    assert.equal(run(database, drift).status, 0);
    reject(database, source, /Exact purge schema predecessor required|drift requires independent review|Exact payroll\/purge function predecessor required/);
  }
  const anchor = '\ndo $payroll_purge_after$';
  assert.ok(source.includes(anchor), 'Actual candidate is missing the protected transition');
  const faults = [
    "create function private.compatibility_unreviewed() returns integer language sql as $$select 1$$;",
    'alter table private.payroll_closing_receipts add column compatibility_unreviewed text;',
    'alter table private.employee_annual_leave_balances add column compatibility_unreviewed text;',
    'grant execute on function public.get_confirmed_test_identity_purge(uuid) to service_role;',
    'grant execute on function private.payroll_closing_immutable() to service_role;',
    'grant select on private.payroll_closing_receipts to service_role;',
    'grant select(note) on private.payroll_closing_receipts to service_role;',
    'grant select(hours) on private.employee_annual_leave_balances to service_role;',
    'grant create on schema private to authenticated;',
    'alter default privileges in schema private grant select on tables to public;',
    'create trigger compatibility_unreviewed before delete on private.payroll_closing_write_claims for each row execute function private.payroll_closing_immutable();',
    'alter table public.leave_requests disable trigger reject_retired_test_identity_reference;',
    'alter table private.payroll_closing_write_claims disable trigger reject_retired_test_identity_reference;',
    'alter table private.payroll_closing_write_claims drop constraint payroll_closing_write_claims_receipt_id_fkey;',
    'alter table private.payroll_closing_receipts owner to service_role;',
    "create or replace function private.payroll_retained_hours(p_person uuid,p_kind text) returns numeric language sql stable security definer set search_path='' as $$select 0::numeric$$;",
    "update private.confirmed_test_identity_purges set retained_audit='{" + '"unreviewed":true' + "}' where phase='complete';",
    "update private.confirmed_test_identity_purges set retained_audit='{" + '"unreviewed":true' + "}' where phase='business_purged';",
  ];
  for (const [index, fault] of faults.entries()) {
    const mutated = source.replace(anchor, () => `\n${fault}${anchor}`);
    assert.notEqual(mutated, source);
    reject(clone(`mam_test_compat_mid_${index}`), mutated, index === 14 ? /Unreviewed|Reviewed payroll|permission denied for schema private/ : /Unreviewed|Reviewed payroll|Existing purge receipts/);
  }
  for (const [index, fault] of [
    'alter table private.payroll_closing_receipts add column compatibility_late text;',
    'grant select(note) on private.payroll_closing_receipts to service_role;',
    "update private.confirmed_test_identity_purges set retained_audit='{" + '"late":true' + "}' where phase='complete';",
  ].entries()) {
    const mutated = source.replace('  update private.confirmed_test_purge_schema set schema_hash=', () => `  ${fault}\n  update private.confirmed_test_purge_schema set schema_hash=`);
    assert.notEqual(mutated, source);
    reject(clone(`mam_test_compat_late_${index}`), mutated, /Late unreviewed payroll migration change/);
  }
  console.log(`PASS: ${cases} actual-candidate pre/intra/late migration fault cases with exact atomic rollback`);
  return cases;
}

export async function testCompatibilityConcurrency({ source, database, args, env, run, snapshot }) {
  let cases = 0;
  for (const [index, lock] of [
    "select pg_advisory_xact_lock(hashtextextended('confirmed-test-purge',0));",
    'select singleton from private.confirmed_test_purge_schema for update;',
    'lock table private.leave_accrual_day_reviews in row exclusive mode;',
    'update private.confirmed_test_identity_purges set retained_audit=retained_audit;',
  ].entries()) {
    const child = spawn('psql', [...args, '-Atq'], { env });
    let stdout = '', stderr = '';
    const exit = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', status => resolve({ status, stderr }));
    });
    child.stderr.on('data', data => { stderr += data; });
    let timer;
    const held = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Synthetic writer never acquired its lock')), 10000);
      child.stdout.on('data', data => { stdout += data; if (stdout.includes('compatibility-lock-held')) resolve(); });
    });
    child.stdin.write(`begin; ${lock} select 'compatibility-lock-held';\n`);
    try {
      await held;
      clearTimeout(timer);
      const before = snapshot(database);
      const started = Date.now();
      const result = run(database, source);
      assert.notEqual(result.status, 0, 'Migration ignored the cooperative lock');
      assert.match(result.stderr, /Concurrent purge|could not obtain lock/);
      assert.ok(Date.now() - started < 1500, 'Migration waited instead of rejecting NOWAIT');
      assert.equal(snapshot(database), before);
      child.stdin.end('lock table public.profiles in row exclusive mode nowait; rollback;\n');
      const writer = await exit;
      assert.equal(writer.status, 0, writer.stderr);
      assert.doesNotMatch(writer.stderr, /deadlock/);
      cases++;
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) { child.stdin.end('rollback;\n'); await exit; }
    }
  }
  console.log(`PASS: ${cases} advisory/guard/receipt/reverse-order ordinary-writer lock cases; bounded rejection, no deadlock`);
  return cases;
}
