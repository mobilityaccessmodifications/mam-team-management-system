"""Deploy the reviewed Leave balance-tab and attachment-delete migration.

Run only through the MAM-scoped Supabase credential helper:
  ... exec supabase -- python3 scripts/deploy-leave-balance-tab-attachment-delete.py inspect
  ... exec supabase -- python3 scripts/deploy-leave-balance-tab-attachment-delete.py apply <sha256>

The script verifies the exact MAM organisation/project and prints only schema
and privilege state. It never reads or prints leave, employee or attachment data.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.request


PROJECT = "xtwlrjqbusadghavchqm"
ORGANISATION = "fwlmbmospuwoaosffvmw"
BASE_VERSION = "20260915160000"
VERSION = "20260916090000"
NAME = "leave_balance_tab_attachment_owner_delete"
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
  to_regprocedure(
    'public.delete_my_leave_request_attachment(uuid)'
  ) is not null as delete_function,
  pg_get_function_result(
    'public.list_leave_workspace_attachments()'::regprocedure
  ) like '%can_delete boolean%' as delete_capability,
  has_function_privilege(
    'authenticated',
    'public.delete_my_leave_request_attachment(uuid)',
    'execute'
  ) as authenticated_execute,
  not has_function_privilege(
    'anon',
    'public.delete_my_leave_request_attachment(uuid)',
    'execute'
  ) as anonymous_denied,
  not has_table_privilege(
    'authenticated',
    'public.leave_request_attachments',
    'delete'
  ) as direct_table_delete_denied,
  exists (
    select 1
    from pg_proc
    where oid = 'public.delete_my_leave_request_attachment(uuid)'::regprocedure
      and prosecdef
      and provolatile = 'v'
  ) as security_definer_volatile
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
        "leaveAttachmentMigrationRecorded": bool(existing),
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
        print("Applied reviewed Leave attachment deletion migration")
    status = schema_status()
    require(all(status.values()), "Deployed Leave attachment deletion schema is incomplete")
    print("Verified deployed Leave attachment deletion schema")
else:
    raise SystemExit("Use inspect or apply <reviewed-sha256>")
