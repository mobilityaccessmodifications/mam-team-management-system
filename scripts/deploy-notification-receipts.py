"""Hash-pinned MAM database cutover; no mail, replay, reset or secret export.

Run only through the project's credential helper. Import/enable also run the
reviewed n8n frozen-snapshot verifier immediately before the DB transaction.
An uncertain mutation is never automatically retried: inspect first.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
TEMP_ROOT = Path('/tmp').resolve()
PROJECT = 'xtwlrjqbusadghavchqm'
ORG = 'fwlmbmospuwoaosffvmw'
WORKFLOW = 'D6UG5ACZGILCpsOk'
VERSION = '20260923010000'
NAME = 'durable_notification_delivery_receipts'
MIGRATION = ROOT / 'supabase/migrations' / f'{VERSION}_{NAME}.sql'
UID = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
KEY = re.compile(rf'(leave:{UID}:(leave-submitted|leave-approved|leave-declined|leave-cancelled|leave-conditionally-approved|leave-reminder|team-birthday):[0-9a-f]{{24}}|payroll-balance:{UID}:[0-9]{{4}}-(0[1-9]|1[0-2])|payroll-comparison:{UID})')


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def bundle_hash():
    return hashlib.sha256(Path(__file__).read_bytes() + b'\0' + MIGRATION.read_bytes()).hexdigest()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def api(path, body=None):
    request = urllib.request.Request('https://api.supabase.com/v1/projects/' + PROJECT + path,
        headers={'Authorization': 'Bearer ' + os.environ['SUPABASE_ACCESS_TOKEN'],
                 'Content-Type': 'application/json', 'User-Agent': 'mam-reviewed-receipt-cutover/1'},
        data=None if body is None else json.dumps(body).encode())
    with urllib.request.build_opener(NoRedirect).open(request, timeout=90) as response:
        return json.load(response)


def query(sql):
    return api('/database/query', {'query': sql})


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate snapshot property')
        result[key] = value
    return result


def parse_snapshot(raw, expected_hash):
    if not re.fullmatch('[0-9a-f]{64}', expected_hash) or hashlib.sha256(raw).hexdigest() != expected_hash:
        raise ValueError('Frozen snapshot SHA-256 mismatch')
    snapshot = json.loads(raw, object_pairs_hook=unique_object)
    if snapshot.get('workflowId') != WORKFLOW or snapshot.get('drainSeconds') != 30 \
            or snapshot.get('nonterminalCount') != 0 or not snapshot.get('versionId') \
            or not snapshot.get('capturedAt') or not re.fullmatch('[0-9a-f]{64}', snapshot.get('bundleSha256', '')):
        raise ValueError('Frozen receiver evidence missing')
    receipts = snapshot.get('receipts')
    if not isinstance(receipts, dict) or len(receipts) > 10000:
        raise ValueError('Unexpected legacy snapshot size')
    entries = []
    for key, receipt in sorted(receipts.items()):
        if not KEY.fullmatch(key) or not isinstance(receipt, dict) or set(receipt) != {'state', 'at'} \
                or receipt['state'] not in ('sent', 'processing') or type(receipt['at']) not in (int, float) \
                or not math.isfinite(receipt['at']) or not 0 <= receipt['at'] <= 253402300799999:
            raise ValueError('Legacy snapshot entry requires review')
        entries.append({'eventKey': key, 'state': 'legacy_sent' if receipt['state'] == 'sent' else 'legacy_unknown', 'at': receipt['at']})
    return snapshot, entries


def snapshot_file(path, expected_hash):
    path = Path(path)
    if not path.is_absolute() or not path.resolve().is_relative_to(TEMP_ROOT) \
            or path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
        raise ValueError('Use the private task-temporary frozen snapshot')
    if path.stat().st_size > 4_000_000:
        raise ValueError('Snapshot too large')
    return parse_snapshot(path.read_bytes(), expected_hash)


def transaction(body):
    return "begin;\nset local lock_timeout='5s';\nset local statement_timeout='75s';\n" + body + '\ncommit;'


def exact_snapshot_sql(entries):
    data = literal(json.dumps(entries, separators=(',', ':')))
    # Full set equality, including original timestamps. No key/address output.
    return f"""if (select count(*) from private.notification_delivery_receipts) <> {len(entries)}
      or exists (select 1 from jsonb_to_recordset({data}::jsonb) as e("eventKey" text,state text,at numeric)
        left join private.notification_delivery_receipts r on r.event_key=e."eventKey"
        where r.event_key is null or r.state is distinct from e.state
          or r.created_at is distinct from to_timestamp((e.at / 1000)::double precision)) then
      raise exception 'Frozen receipt set does not match imported store';
    end if;"""


def import_sql(entries, snapshot_hash):
    data = literal(json.dumps(entries, separators=(',', ':')))
    return transaction(f"""select private.lock_notification_delivery_store();
do $cutover$ begin
  if (select ready from private.notification_delivery_control where singleton) is distinct from false then
    raise exception 'Import requires disabled store'; end if;
  if exists (select 1 from private.notification_delivery_control where singleton
    and legacy_import_sha256 is not null and legacy_import_sha256 <> {literal(snapshot_hash)}) then
    raise exception 'Different import proof already recorded'; end if;
  perform private.import_notification_delivery_legacy({data}::jsonb);
  {exact_snapshot_sql(entries)}
  update private.notification_delivery_control set legacy_import_sha256={literal(snapshot_hash)},
    legacy_import_count={len(entries)}, legacy_imported_at=coalesce(legacy_imported_at,clock_timestamp()),
    changed_at=clock_timestamp() where singleton and not ready;
  if not found then raise exception 'Disabled control missing'; end if;
end $cutover$;
select ready,legacy_import_sha256,legacy_import_count from private.notification_delivery_control where singleton;""")


def enable_sql(entries, snapshot_hash):
    return transaction(f"""select private.lock_notification_delivery_store();
do $cutover$ begin
  if not exists (select 1 from private.notification_delivery_control where singleton
    and legacy_import_sha256={literal(snapshot_hash)} and legacy_import_count={len(entries)}
    and legacy_imported_at is not null) then raise exception 'Matching import proof required'; end if;
  {exact_snapshot_sql(entries)}
  perform private.set_notification_delivery_ready(true);
end $cutover$;
select public.notification_delivery_store_status() as status;""")


def apply_migration():
    sql = MIGRATION.read_text()
    recorded = query('select statements from supabase_migrations.schema_migrations where version=' + literal(VERSION))
    if recorded:
        if len(recorded) != 1 or recorded[0]['statements'] != [sql]:
            raise ValueError('Recorded migration differs')
        return
    if not sql.startswith('begin;\n') or sql.count('\ncommit;') != 1 or not sql.rstrip().endswith('commit;'):
        raise ValueError('Unexpected migration transaction structure')
    history = 'insert into supabase_migrations.schema_migrations(version,name,statements) values (' \
        + literal(VERSION) + ',' + literal(NAME) + ',ARRAY[' + literal(sql) + ']);'
    query(sql.replace('begin;', "begin;\nset local lock_timeout='5s';\nset local statement_timeout='75s';", 1)
          .replace('\ncommit;', '\n' + history + "\nnotify pgrst,'reload schema';\ncommit;"))
    after = query('select statements from supabase_migrations.schema_migrations where version=' + literal(VERSION))
    if len(after) != 1 or after[0]['statements'] != [sql]:
        raise ValueError('Migration read-back mismatch')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['hash', 'status', 'apply', 'import', 'enable'])
    parser.add_argument('--reviewed-sha256')
    parser.add_argument('--snapshot')
    parser.add_argument('--snapshot-sha256')
    args = parser.parse_args()
    if args.operation == 'hash':
        print(bundle_hash())
        return
    if args.operation != 'status' and args.reviewed_sha256 != bundle_hash():
        raise ValueError('Reviewed database release bundle differs')
    project = api('')
    if project.get('id') != PROJECT or project.get('organization_id') != ORG:
        raise ValueError('MAM Supabase target mismatch')
    if args.operation == 'status':
        installed = query("select to_regclass('private.notification_delivery_control') is not null as installed")
        print(json.dumps(installed))
        if installed[0]['installed']:
            print(json.dumps(query('select ready,legacy_import_sha256,legacy_import_count,legacy_imported_at from private.notification_delivery_control where singleton')))
            print(json.dumps(query('select state,count(*) as count from private.notification_delivery_receipts group by state order by state')))
        return
    if args.operation == 'apply':
        apply_migration()
        print(json.dumps({'operation': 'apply', 'version': VERSION, 'verified': True}))
        return
    if not args.snapshot or not args.snapshot_sha256:
        raise ValueError('Frozen snapshot and reviewed digest required')
    snapshot, entries = snapshot_file(args.snapshot, args.snapshot_sha256)
    subprocess.run([sys.executable, str(ROOT / 'scripts/deploy-notification-review.py'),
        'verify-snapshot', args.snapshot, args.snapshot_sha256,
        'desired' if args.operation == 'enable' else 'baseline'], check=True)
    # Re-read local file after the external check; never silently import a changed file.
    if snapshot_file(args.snapshot, args.snapshot_sha256) != (snapshot, entries):
        raise ValueError('Frozen snapshot changed')
    sql = import_sql(entries, args.snapshot_sha256) if args.operation == 'import' else enable_sql(entries, args.snapshot_sha256)
    query(sql)
    control = query('select ready,legacy_import_sha256,legacy_import_count from private.notification_delivery_control where singleton')
    expected = {'ready': args.operation == 'enable', 'legacy_import_sha256': args.snapshot_sha256, 'legacy_import_count': len(entries)}
    if control != [expected]:
        raise ValueError('Cutover control read-back differs; inspect before retry')
    print(json.dumps({'operation': args.operation, 'verified': True, **expected}))


if __name__ == '__main__':
    try:
        main()
    except (urllib.error.URLError, subprocess.CalledProcessError):
        raise SystemExit('MAM verification/provider request unavailable; inspect before any retry')
    except (ValueError, KeyError) as error:
        # Validation errors are fixed sanitized messages, never provider payloads.
        raise SystemExit(str(error) if isinstance(error, ValueError) else 'Required MAM release configuration unavailable')
