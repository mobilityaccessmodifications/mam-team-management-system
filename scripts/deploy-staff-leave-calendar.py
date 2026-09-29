"""Inspect or apply the reviewed staff Calendar migration on the exact MAM project.

Run through the MAM Supabase credential helper only. Inspect prints schema state,
not employee or leave data. Apply requires the reviewed migration SHA-256.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.request

PROJECT = "xtwlrjqbusadghavchqm"
ORGANISATION = "fwlmbmospuwoaosffvmw"
VERSION = "20260929120000"
NAME = "staff_leave_calendar_details"
MIGRATION = Path(__file__).resolve().parents[1] / "supabase" / "migrations" / f"{VERSION}_{NAME}.sql"
MIGRATIONS = MIGRATION.parent
PREDECESSORS = {
    "public.list_leave_calendar_entries()": "20260923160000_employee_team_calendar.sql",
    "public.list_leave_calendar_entries_for_preview(uuid)": "20260923160000_employee_team_calendar.sql",
    "public.list_leave_calendar_entries_with_teams()": "20260921180000_calendar_team_filters.sql",
    "public.list_leave_calendar_entries_with_teams_for_preview(uuid)": "20260921180000_calendar_team_filters.sql",
    "private.is_calendar_manager(uuid)": "20260921180000_calendar_team_filters.sql",
    "private.can_view_all_approved_leave_calendar_for(uuid)": "20260916130000_personal_calendar_scope.sql",
    "private.manager_calendar_team_ids(uuid)": "20260921160000_manager_team_leave_calendar.sql",
}


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def api(path, body=None):
    request = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{PROJECT}{path}",
        headers={"Authorization": "Bearer " + os.environ["SUPABASE_ACCESS_TOKEN"],
                 "Content-Type": "application/json", "User-Agent": "supabase-cli/2.54.11"},
        data=None if body is None else json.dumps(body).encode(),
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.load(response)


def query(sql):
    return api("/database/query", {"query": sql})


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def verify_predecessors():
    signatures = ",".join(literal(signature) for signature in PREDECESSORS)
    functions = query(f"""select n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as signature,
      p.prosrc,p.prosecdef,p.proconfig
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where p.oid in (select unnest(array[{signatures}])::regprocedure)""")
    require(len(functions) == len(PREDECESSORS), "Calendar predecessor functions missing")
    for function in functions:
        signature = function["signature"]
        require(signature in PREDECESSORS, "Unexpected calendar predecessor")
        require(function["prosrc"] in (MIGRATIONS / PREDECESSORS[signature]).read_text(),
                "Calendar predecessor drift: " + signature)
        require(function["prosecdef"] and function["proconfig"] == ['search_path=""'],
                "Calendar predecessor security drift: " + signature)
    state = query("""select
      not has_function_privilege('authenticated','private.is_calendar_manager(uuid)','EXECUTE') as manager_private,
      not has_function_privilege('authenticated','private.can_view_all_approved_leave_calendar_for(uuid)','EXECUTE') as grant_private,
      not has_function_privilege('authenticated','private.manager_calendar_team_ids(uuid)','EXECUTE') as team_private,
      not has_function_privilege('anon','public.list_leave_calendar_entries_with_teams()','EXECUTE') as anonymous_denied,
      not has_function_privilege('anon','public.list_leave_calendar_entries_with_teams_for_preview(uuid)','EXECUTE') as anonymous_preview_denied,
      has_function_privilege('authenticated','public.list_leave_calendar_entries_with_teams()','EXECUTE') as team_enabled,
      has_function_privilege('authenticated','public.list_leave_calendar_entries_with_teams_for_preview(uuid)','EXECUTE') as preview_enabled""")[0]
    require(all(state.values()), "Calendar predecessor ACL drift")


def verify_schema(sql):
    functions = query("""select n.nspname,p.proname,p.prosrc,p.prosecdef,p.proconfig
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where (n.nspname='private' and p.proname='staff_leave_calendar_entries')
         or (n.nspname='public' and p.proname in
           ('list_staff_leave_calendar_entries','list_staff_leave_calendar_entries_for_preview'))""")
    require(len(functions) == 3, "Expected staff Calendar functions missing")
    for function in functions:
        require(function["prosrc"] in sql, "Deployed staff Calendar function differs")
        require(function["prosecdef"] and function["proconfig"] == ['search_path=""'],
                "Staff Calendar function security differs")
    state = query("""select
      not has_function_privilege('authenticated','private.staff_leave_calendar_entries(uuid,uuid,boolean)','EXECUTE') as helper_private,
      not has_function_privilege('anon','public.list_staff_leave_calendar_entries()','EXECUTE') as anonymous_denied,
      not has_function_privilege('anon','public.list_staff_leave_calendar_entries_for_preview(uuid)','EXECUTE') as anonymous_preview_denied,
      has_function_privilege('authenticated','public.list_staff_leave_calendar_entries()','EXECUTE') as staff_calendar_enabled,
      has_function_privilege('authenticated','public.list_staff_leave_calendar_entries_for_preview(uuid)','EXECUTE') as preview_enabled""")[0]
    require(all(state.values()), "Staff Calendar ACL verification failed")
    print(json.dumps(state))


def main():
    operation = sys.argv[1] if len(sys.argv) > 1 else ""
    require(operation in ("inspect", "apply"), "Use inspect or apply <reviewed-sha256>")
    require(len(sys.argv) == (3 if operation == "apply" else 2), "Use inspect or apply <reviewed-sha256>")
    sql = MIGRATION.read_text()
    if operation == "apply":
        require(hashlib.sha256(sql.encode()).hexdigest() == sys.argv[2], "Reviewed migration differs")
    project = api("")
    require(project["id"] == PROJECT and project["organization_id"] == ORGANISATION,
            "MAM Supabase target mismatch")
    base = query("select version from supabase_migrations.schema_migrations where version='20260923160000'")
    require(bool(base), "Employee team Calendar predecessor missing")
    verify_predecessors()
    existing = query("select statements from supabase_migrations.schema_migrations where version=" + literal(VERSION))
    if existing:
        require(existing[0]["statements"] == [sql], "Recorded migration differs")
    print(json.dumps({"project": PROJECT, "migrationRecorded": bool(existing)}))
    if operation == "apply" and not existing:
        require(sql.startswith("begin;\n") and sql.count("\ncommit;") == 1,
                "Unexpected transaction structure")
        history = "insert into supabase_migrations.schema_migrations(version,name,statements) values(" + literal(VERSION) + "," + literal(NAME) + ",ARRAY[" + literal(sql) + "]);"
        release = sql.replace("begin;", "begin;\nset local lock_timeout='5s';\nset local statement_timeout='75s';", 1).replace("\ncommit;", "\n" + history + "\nnotify pgrst,'reload schema';\ncommit;")
        query(release)
    if existing or operation == "apply":
        verify_schema(sql)


if __name__ == "__main__":
    main()
