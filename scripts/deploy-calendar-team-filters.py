"""Deploy the reviewed cross-team approved Calendar projection and team labels.

Run only through the MAM-scoped Supabase credential helper:
  ... exec supabase -- python3 scripts/deploy-calendar-team-filters.py inspect
  ... exec supabase -- python3 scripts/deploy-calendar-team-filters.py apply <sha256>

The script verifies the exact MAM organisation/project and reports schema
state only. It never reads or prints employee names or leave values.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.request


PROJECT = "xtwlrjqbusadghavchqm"
ORGANISATION = "fwlmbmospuwoaosffvmw"
BASE_VERSION = "20260921160000"
VERSION = "20260921180000"
NAME = "calendar_team_filters"
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
  not has_function_privilege('authenticated','private.is_calendar_manager(uuid)','EXECUTE') as private_role_check,
  has_function_privilege('authenticated','public.list_leave_calendar_entries_with_teams()','EXECUTE') as scoped_team_projection,
  has_function_privilege('authenticated','public.list_leave_calendar_entries_with_teams_for_preview(uuid)','EXECUTE') as scoped_preview,
  position('v_is_manager and employee.is_active' in pg_get_functiondef('public.list_leave_calendar_entries()'::regprocedure)) > 0 as active_approved_scope,
  position('v_is_manager and employee.is_active' in pg_get_functiondef('public.list_leave_calendar_entries_for_preview(uuid)'::regprocedure)) > 0 as matching_preview_scope
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
    "select version, statements from supabase_migrations.schema_migrations where version="
    + literal(VERSION)
)
require(bool(base), "The manager Calendar scope migration is not recorded")
if existing:
    require(existing[0]["statements"] == [MIGRATION.read_text()], "Recorded migration differs")

if operation == "inspect":
    require(len(sys.argv) == 2, "Use inspect")
    result = {
        "baseMigrationRecorded": True,
        "calendarTeamFiltersMigrationRecorded": bool(existing),
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
        print("Applied reviewed cross-team Calendar migration")
    require(
        all(schema_status().values()),
        "Deployed cross-team Calendar schema is incomplete",
    )
    print("Verified deployed cross-team Calendar schema")
else:
    raise SystemExit("Use inspect or apply <reviewed-sha256>")
