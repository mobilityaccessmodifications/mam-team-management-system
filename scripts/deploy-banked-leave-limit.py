"""Hash-pinned MAM-only migration; use project credential exec supabase route.

inspect is read-only. apply requires the reviewed migration SHA256.
No employee rows, secrets or email payloads are printed.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.request

PROJECT = "xtwlrjqbusadghavchqm"
ORGANISATION = "fwlmbmospuwoaosffvmw"
VERSION = "20260922120000"
NAME = "banked_annual_leave_request_limit"
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
    state = query("""select
      exists(select 1 from pg_trigger where tgrelid='public.leave_requests'::regclass
        and tgname='z_leave_requests_banked_annual_limit' and tgenabled='O') as trigger_enabled,
      not has_function_privilege('authenticated','private.enforce_banked_annual_leave_request()','EXECUTE') as private_trigger,
      not has_function_privilege('authenticated','public.get_leave_priority_workspace_before_request_limit(uuid)','EXECUTE') as private_previous_projection,
      position('requestFullDayHours' in pg_get_functiondef('public.get_leave_priority_workspace(uuid)'::regprocedure))>0 as duration_metadata
    """)[0]
    require(all(state.values()), "Deployed schema verification failed")
    print(json.dumps(state))


operation = sys.argv[1] if len(sys.argv) > 1 else ""
require(operation in ("inspect", "apply"), "Use inspect or apply <reviewed-sha256>")
sql = MIGRATION.read_text()
if operation == "apply":
    require(len(sys.argv) == 3 and hashlib.sha256(sql.encode()).hexdigest() == sys.argv[2], "Reviewed migration differs")
project = api("")
require(project["id"] == PROJECT and project["organization_id"] == ORGANISATION, "MAM target mismatch")
base = query("select version from supabase_migrations.schema_migrations where version='20260917090100'")
require(bool(base), "Approved-balance migration missing")
existing = query("select statements from supabase_migrations.schema_migrations where version=" + literal(VERSION))
if existing:
    require(existing[0]["statements"] == [sql], "Recorded migration differs")
print(json.dumps({"project": PROJECT, "migrationRecorded": bool(existing)}))
if operation == "apply" and not existing:
    require(sql.count("\ncommit;") == 1, "Unexpected transaction structure")
    history = "insert into supabase_migrations.schema_migrations(version,name,statements) values(" + literal(VERSION) + "," + literal(NAME) + ",ARRAY[" + literal(sql) + "]);"
    release = sql.replace("begin;", "begin;\nset local lock_timeout='5s';\nset local statement_timeout='75s';", 1).replace("\ncommit;", "\n" + history + "\nnotify pgrst,'reload schema';\ncommit;")
    query(release)
if existing or operation == "apply":
    verify_schema()
