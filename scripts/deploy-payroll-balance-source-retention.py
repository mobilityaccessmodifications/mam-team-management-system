"""Deploy the reviewed private payroll source-file retention migration.

Run only through the MAM-scoped Supabase credential helper:
  ... exec supabase -- python3 scripts/deploy-payroll-balance-source-retention.py inspect
  ... exec supabase -- python3 scripts/deploy-payroll-balance-source-retention.py apply <sha256>

The script verifies the exact MAM organisation/project and reports only schema,
privilege and aggregate retention state. It never reads or prints file names,
Storage paths, employee records or payroll balances.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.request


PROJECT = "xtwlrjqbusadghavchqm"
ORGANISATION = "fwlmbmospuwoaosffvmw"
BASE_VERSION = "20260915120000"
VERSION = "20260918100000"
NAME = "payroll_balance_source_file_retention"
ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / f"{VERSION}_{NAME}.sql"


def api(path, body=None):
    request = urllib.request.Request(
        "https://api.supabase.com/v1/projects/" + PROJECT + path,
        headers={
            "Authorization": "Bearer " + os.environ["SUPABASE_ACCESS_TOKEN"],
            "Content-Type": "application/json",
            "User-Agent": "supabase-cli/2.54.11",
        },
        data=None if body is None else json.dumps(body).encode(),
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.load(response)


def query(sql):
    return api("/database/query", {"query": sql})


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def schema_status():
    return query("""
select
  to_regclass('private.payroll_balance_source_archives') is not null
    as archive_table,
  coalesce((
    select not bucket.public
      and bucket.file_size_limit = 500000
      and bucket.allowed_mime_types @> array[
        'text/csv',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      ]::text[]
    from storage.buckets bucket
    where bucket.id = 'payroll-balance-archives'
  ), false) as private_archive_bucket,
  coalesce((
    select relation.relrowsecurity
    from pg_class relation
    where relation.oid = 'private.payroll_balance_source_archives'::regclass
  ), false) as archive_table_rls,
  not has_table_privilege(
    'authenticated', 'private.payroll_balance_source_archives', 'SELECT'
  ) as browser_metadata_denied,
  to_regprocedure(
    'public.prepare_payroll_balance_source_archive(uuid,text,text,integer,text)'
  ) is not null as prepare_function,
  to_regprocedure(
    'public.complete_payroll_balance_source_archive(uuid,uuid)'
  ) is not null as complete_function,
  to_regprocedure(
    'public.mark_payroll_balance_source_archives_failed(uuid,uuid[])'
  ) is not null as failure_function,
  to_regprocedure(
    'public.link_payroll_balance_source_archives(uuid,uuid[],uuid)'
  ) is not null as link_function,
  to_regprocedure(
    'public.list_expired_payroll_balance_source_archives()'
  ) is not null as retention_list_function,
  to_regprocedure(
    'public.complete_payroll_balance_source_archive_deletion(uuid[])'
  ) is not null as retention_delete_function,
  not has_function_privilege(
    'authenticated',
    'public.prepare_payroll_balance_source_archive(uuid,text,text,integer,text)',
    'EXECUTE'
  ) as browser_prepare_denied,
  not has_function_privilege(
    'authenticated',
    'public.list_expired_payroll_balance_source_archives()',
    'EXECUTE'
  ) as browser_retention_denied,
  has_function_privilege(
    'service_role',
    'public.prepare_payroll_balance_source_archive(uuid,text,text,integer,text)',
    'EXECUTE'
  ) as service_prepare_access,
  has_function_privilege(
    'service_role',
    'public.complete_payroll_balance_source_archive_deletion(uuid[])',
    'EXECUTE'
  ) as service_cleanup_access,
  exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'private.payroll_balance_source_archives'::regclass
      and pg_get_constraintdef(constraint_row.oid) like
        '%retain_until >= (created_at +%30 days%'
  ) as minimum_retention_constraint,
  not exists (
    select 1
    from pg_policies policy
    where policy.schemaname = 'storage'
      and policy.tablename = 'objects'
      and policy.qual like '%payroll-balance-archives%'
  ) as no_browser_storage_policy
""")[0]


def aggregate_status():
    return query("""
select
  count(*)::integer as archive_records,
  count(*) filter (
    where archive.deleted_at is null
      and archive.retain_until <= clock_timestamp()
  )::integer as eligible_for_cleanup
from private.payroll_balance_source_archives archive
""")[0]


project = api("")
require(
    project["id"] == PROJECT and project["organization_id"] == ORGANISATION,
    "MAM Supabase target mismatch",
)
print("Verified MAM project", PROJECT)

operation = sys.argv[1] if len(sys.argv) > 1 else ""
base = query(
    "select version from supabase_migrations.schema_migrations where version="
    + literal(BASE_VERSION)
)
existing = query(
    "select version from supabase_migrations.schema_migrations where version="
    + literal(VERSION)
)
require(bool(base), "The payroll balance self-service migration is not recorded")

if operation == "inspect":
    require(len(sys.argv) == 2, "Use inspect")
    result = {
        "baseMigrationRecorded": True,
        "sourceRetentionMigrationRecorded": bool(existing),
    }
    if existing:
        result["schema"] = schema_status()
        result["aggregates"] = aggregate_status()
    print(json.dumps(result, indent=2))
elif operation == "apply":
    require(len(sys.argv) == 3, "Use apply <reviewed-sha256>")
    sql = MIGRATION.read_text()
    require(
        hashlib.sha256(sql.encode()).hexdigest() == sys.argv[2],
        "Reviewed migration differs",
    )
    if existing:
        print("Migration already recorded; checking deployed schema")
    else:
        require(sql.count("\ncommit;") == 1, "Unexpected migration transaction structure")
        history = (
            "insert into supabase_migrations.schema_migrations(version,name,statements) values("
            + literal(VERSION)
            + ","
            + literal(NAME)
            + ",ARRAY["
            + literal(sql)
            + "]);"
        )
        release_sql = sql.replace(
            "begin;",
            "begin;\nset local lock_timeout='5s';\nset local statement_timeout='75s';",
            1,
        ).replace(
            "\ncommit;",
            "\n" + history + "\nnotify pgrst,'reload schema';\ncommit;",
        )
        query(release_sql)
        print("Applied reviewed payroll source-file retention migration")
    status = schema_status()
    require(all(status.values()), "Deployed payroll source retention schema is incomplete")
    print("Verified deployed payroll source-file retention schema")
    print(json.dumps(aggregate_status(), indent=2))
else:
    raise SystemExit("Use inspect or apply <reviewed-sha256>")
