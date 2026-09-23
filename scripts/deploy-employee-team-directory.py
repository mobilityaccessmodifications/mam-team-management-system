import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.request

PROJECT = "xtwlrjqbusadghavchqm"
ORGANISATION = "fwlmbmospuwoaosffvmw"
VERSION = "20260923170000"
NAME = "employee_team_directory"
MIGRATION = Path(__file__).resolve().parents[1] / "supabase" / "migrations" / f"{VERSION}_{NAME}.sql"


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


def verify_schema():
    functions = query("""select p.proname,p.prosrc,p.prosecdef,p.proconfig
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where (n.nspname='private' and p.proname='list_current_employee_people_branch_node_ids')
        or (n.nspname='public' and p.proname='list_employee_team_directory')""")
    require(len(functions) == 2, "Directory functions missing")
    for function in functions:
        require(function['prosrc'] in sql, "Deployed directory function differs")
        require(function['prosecdef'] and function['proconfig'] == ['search_path=""'], "Function security differs")
    state = query("""select
      not has_function_privilege('authenticated','private.list_current_employee_people_branch_node_ids()','EXECUTE') as helper_private,
      not has_function_privilege('anon','public.list_employee_team_directory(uuid)','EXECUTE') as anonymous_denied,
      has_function_privilege('authenticated','public.list_employee_team_directory(uuid)','EXECUTE') as directory_enabled
    """)[0]
    require(all(state.values()), "Directory ACL verification failed")
    print(json.dumps(state))


operation = sys.argv[1] if len(sys.argv) > 1 else ""
require(operation in ("inspect", "apply"), "Use inspect or apply <reviewed-sha256>")
sql = MIGRATION.read_text()
if operation == "apply":
    require(len(sys.argv) == 3 and hashlib.sha256(sql.encode()).hexdigest() == sys.argv[2], "Reviewed migration differs")
project = api("")
require(project["id"] == PROJECT and project["organization_id"] == ORGANISATION, "MAM target mismatch")
base = query("select version from supabase_migrations.schema_migrations where version='20260923160000'")
require(bool(base), "Employee team calendar migration missing")
existing = query("select statements from supabase_migrations.schema_migrations where version=" + literal(VERSION))
if existing:
    require(existing[0]["statements"] == [sql], "Recorded migration differs")
print(json.dumps({"project": PROJECT, "migrationRecorded": bool(existing)}))
if not existing:
    predecessor = (MIGRATION.parent / "20260917123501_people_operational_tab_access.sql").read_text()
    deployed = query("select prosrc from pg_proc where oid='private.list_current_employee_people_branch_node_ids()'::regprocedure")
    require(len(deployed) == 1 and deployed[0]['prosrc'] in predecessor, "Directory predecessor drift")
if operation == "apply" and not existing:
    require(sql.count("\ncommit;") == 1, "Unexpected transaction structure")
    history = "insert into supabase_migrations.schema_migrations(version,name,statements) values(" + literal(VERSION) + "," + literal(NAME) + ",ARRAY[" + literal(sql) + "]);"
    release = sql.replace("begin;", "begin;\nset local lock_timeout='5s';\nset local statement_timeout='75s';", 1).replace("\ncommit;", "\n" + history + "\nnotify pgrst,'reload schema';\ncommit;")
    query(release)
if existing or operation == "apply":
    verify_schema()
