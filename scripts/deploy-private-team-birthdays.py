"""Deploy the reviewed private employee/manager-team birthday projection.

Run only through the MAM-scoped Supabase credential helper:
  ... exec supabase -- python3 scripts/deploy-private-team-birthdays.py inspect
  ... exec supabase -- python3 scripts/deploy-private-team-birthdays.py apply <sha256>

The script verifies the exact MAM organisation/project and reports schema
state only. It never reads or prints employee names or birthday values.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.request


PROJECT = "xtwlrjqbusadghavchqm"
ORGANISATION = "fwlmbmospuwoaosffvmw"
BASE_VERSION = "20260916130000"
VERSION = "20260916140000"
NAME = "private_team_calendar_birthdays"
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
    'private.list_calendar_birthday_person_ids_for(uuid)'
  ) is not null as private_scope_helper,
  not has_function_privilege(
    'authenticated',
    'private.list_calendar_birthday_person_ids_for(uuid)',
    'EXECUTE'
  ) as private_helper_not_browser_executable,
  pg_get_function_result('public.list_calendar_birthdays()'::regprocedure)
    = 'TABLE(employee_name text, birthday_month smallint, birthday_day smallint)'
      as live_minimal_contract,
  to_regprocedure(
    'public.list_calendar_birthdays_for_preview(uuid)'
  ) is not null as preview_projection,
  pg_get_function_result(
    'public.list_calendar_birthdays_for_preview(uuid)'::regprocedure
  ) = 'TABLE(employee_name text, birthday_month smallint, birthday_day smallint)'
      as preview_minimal_contract,
  has_function_privilege(
    'authenticated', 'public.list_calendar_birthdays()', 'EXECUTE'
  ) as live_browser_access,
  has_function_privilege(
    'authenticated',
    'public.list_calendar_birthdays_for_preview(uuid)',
    'EXECUTE'
  ) as preview_browser_access,
  position(
    'private.list_calendar_birthday_person_ids_for(v_actor_person_id)'
    in pg_get_functiondef('public.list_calendar_birthdays()'::regprocedure)
  ) > 0 as live_uses_private_scope,
  position(
    'private.list_calendar_birthday_person_ids_for(p_person_id)'
    in pg_get_functiondef(
      'public.list_calendar_birthdays_for_preview(uuid)'::regprocedure
    )
  ) > 0 as preview_uses_selected_scope
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
require(bool(base), "The personal Calendar scope migration is not recorded")

if operation == "inspect":
    require(len(sys.argv) == 2, "Use inspect")
    result = {
        "baseMigrationRecorded": True,
        "birthdayMigrationRecorded": bool(existing),
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
        print("Applied reviewed private team birthday migration")
    require(
        all(schema_status().values()),
        "Deployed private team birthday schema is incomplete",
    )
    print("Verified deployed private team birthday schema")
else:
    raise SystemExit("Use inspect or apply <reviewed-sha256>")
