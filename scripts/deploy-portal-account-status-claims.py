"""Deploy the reviewed portal-account status claim migration.

Run only through the MAM-scoped Supabase credential helper:
  ... exec supabase -- python3 scripts/deploy-portal-account-status-claims.py inspect
  ... exec supabase -- python3 scripts/deploy-portal-account-status-claims.py apply <sha256>

The script verifies the exact MAM organisation/project and prints only schema
and privilege state. It never reads or prints employee or account records.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.request


PROJECT = "xtwlrjqbusadghavchqm"
ORGANISATION = "fwlmbmospuwoaosffvmw"
BASE_VERSION = "20260916090000"
VERSION = "20260916120000"
NAME = "serialise_portal_account_status_changes"
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
  to_regclass('private.portal_account_status_change_claims') is not null
    as claims_table,
  coalesce((
    select relation.relrowsecurity
    from pg_class relation
    where relation.oid = to_regclass('private.portal_account_status_change_claims')
  ), false) as claims_rls,
  not (
    coalesce(has_table_privilege(
      'authenticated',
      to_regclass('private.portal_account_status_change_claims'),
      'select'
    ), false)
    or coalesce(has_table_privilege(
      'authenticated',
      to_regclass('private.portal_account_status_change_claims'),
      'insert'
    ), false)
    or coalesce(has_table_privilege(
      'authenticated',
      to_regclass('private.portal_account_status_change_claims'),
      'update'
    ), false)
    or coalesce(has_table_privilege(
      'authenticated',
      to_regclass('private.portal_account_status_change_claims'),
      'delete'
    ), false)
  ) as claims_private,
  to_regprocedure(
    'public.begin_portal_account_status_change(uuid,uuid,boolean,bigint)'
  ) is not null as begin_function,
  to_regprocedure(
    'public.cancel_portal_account_status_change(uuid,uuid)'
  ) is not null as cancel_function,
  to_regprocedure(
    'public.inspect_portal_account_status_change(uuid,uuid)'
  ) is not null as inspect_function,
  to_regprocedure(
    'public.finalise_portal_account_status_change(uuid,uuid,uuid)'
  ) is not null as finalise_function,
  coalesce(has_function_privilege(
    'authenticated',
    to_regprocedure(
      'public.begin_portal_account_status_change(uuid,uuid,boolean,bigint)'
    ),
    'execute'
  ), false) as authenticated_begin,
  coalesce(has_function_privilege(
    'authenticated',
    to_regprocedure('public.cancel_portal_account_status_change(uuid,uuid)'),
    'execute'
  ), false) as authenticated_cancel,
  coalesce(has_function_privilege(
    'authenticated',
    to_regprocedure('public.inspect_portal_account_status_change(uuid,uuid)'),
    'execute'
  ), false) as authenticated_inspect,
  coalesce(has_function_privilege(
    'authenticated',
    to_regprocedure(
      'public.finalise_portal_account_status_change(uuid,uuid,uuid)'
    ),
    'execute'
  ), false) as authenticated_finalise,
  not coalesce(has_function_privilege(
    'anon',
    to_regprocedure(
      'public.begin_portal_account_status_change(uuid,uuid,boolean,bigint)'
    ),
    'execute'
  ), false) as anonymous_begin_denied,
  not coalesce(has_function_privilege(
    'anon',
    to_regprocedure('public.cancel_portal_account_status_change(uuid,uuid)'),
    'execute'
  ), false) as anonymous_cancel_denied,
  not coalesce(has_function_privilege(
    'anon',
    to_regprocedure('public.inspect_portal_account_status_change(uuid,uuid)'),
    'execute'
  ), false) as anonymous_inspect_denied,
  not coalesce(has_function_privilege(
    'anon',
    to_regprocedure(
      'public.finalise_portal_account_status_change(uuid,uuid,uuid)'
    ),
    'execute'
  ), false) as anonymous_finalise_denied,
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = to_regclass('public.profiles')
      and trigger_row.tgname = 'profiles_account_status_change_claim_guard'
      and not trigger_row.tgisinternal
      and trigger_row.tgenabled <> 'D'
  ) as profile_guard,
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = to_regclass('private.portal_password_reset_claims')
      and trigger_row.tgname = 'portal_password_reset_status_change_guard'
      and not trigger_row.tgisinternal
      and trigger_row.tgenabled <> 'D'
  ) as password_reset_guard
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
require(bool(base), "The preceding MAM migration is not recorded")

if operation == "inspect":
    result = {
        "baseMigrationRecorded": True,
        "accountStatusClaimMigrationRecorded": bool(existing),
    }
    if existing:
        result["schema"] = schema_status()
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
        print("Applied reviewed portal-account status claim migration")
    status = schema_status()
    require(all(status.values()), "Deployed account-status claim schema is incomplete")
    print("Verified deployed portal-account status claim schema")
else:
    raise SystemExit("Use inspect or apply <reviewed-sha256>")
