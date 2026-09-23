"""Hash-pinned deployment for private Check-In review outcomes."""

import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request


PROJECT = "xtwlrjqbusadghavchqm"
ORGANISATION = "fwlmbmospuwoaosffvmw"
VERSION = "20260923230000"
NAME = "check_in_review_outcomes"
MIGRATION = Path(__file__).resolve().parents[1] / "supabase" / "migrations" / f"{VERSION}_{NAME}.sql"
MIGRATIONS = MIGRATION.parent
REVIEWED_PREDECESSORS = {
    "20260819120000_employee_check_in_reminders.sql":
        "8863a1f67fb5af23e4b277f2bd4085bdf1e7699fb769429b486014c1f68a9bfa",
    "20260820170000_set_based_check_in_scope.sql":
        "6b37490134795c98246f2a51c9bf8cc2ba98cccea7c307439b4f639b83c72821",
    "20260824160000_harden_manager_checkin_scope.sql":
        "4a26221e22fb9e5d827548995da9ecd6f8692560e9d57b8329bf7b1db30afe2a",
    "20260825150000_role_aware_checkin_authority.sql":
        "2357c85a5a1b7334a6bc368512f7bdc25179987312c8f9925ba34fb87bcd0b76",
}
PREDECESSOR_FUNCTIONS = {
    "public.list_employee_check_in_register()": (
        "20260819120000_employee_check_in_reminders.sql",
        "create function public.list_employee_check_in_register()",
        "plpgsql",
    ),
    "private.can_view_employee_check_in(uuid)": (
        "20260824160000_harden_manager_checkin_scope.sql",
        "create or replace function private.can_view_employee_check_in(p_person_id uuid)",
        "sql",
    ),
    "public.list_employee_check_in_workspace()": (
        "20260820170000_set_based_check_in_scope.sql",
        "create or replace function public.list_employee_check_in_workspace()",
        "plpgsql",
    ),
    "public.list_employee_check_in_workspace_for_preview(uuid)": (
        "20260825150000_role_aware_checkin_authority.sql",
        "create or replace function public.list_employee_check_in_workspace_for_preview(p_person_id uuid)",
        "plpgsql",
    ),
}


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def api(path, body=None):
    request = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{PROJECT}{path}",
        headers={
            "Authorization": "Bearer " + os.environ["SUPABASE_ACCESS_TOKEN"],
            "Content-Type": "application/json",
            "User-Agent": "supabase-cli/2.54.11",
        },
        data=None if body is None else json.dumps(body).encode(),
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")
        raise SystemExit(f"Supabase API request failed ({error.code}): {detail}") from error


def query(sql):
    return api("/database/query", {"query": sql})


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def reviewed_function_body(filename, header):
    source = (MIGRATIONS / filename).read_text()
    require(
        hashlib.sha256(source.encode()).hexdigest() == REVIEWED_PREDECESSORS[filename],
        f"Reviewed predecessor source differs: {filename}",
    )
    function_start = source.find(header)
    require(function_start >= 0, f"Reviewed function header is missing: {header}")
    body_start = source.find("as $$", function_start)
    require(body_start >= 0, f"Reviewed function body is missing: {header}")
    body_start += len("as $$")
    body_end = source.find("$$;", body_start)
    require(body_end >= 0, f"Reviewed function terminator is missing: {header}")
    return source[body_start:body_end]


def verify_predecessor_functions():
    functions = query("""select
      expected.signature,
      p.prosrc,
      p.prosecdef,
      p.proconfig,
      language.lanname,
      p.provolatile
    from (values
      ('public.list_employee_check_in_register()', 'public.list_employee_check_in_register()'),
      ('private.can_view_employee_check_in(uuid)', 'private.can_view_employee_check_in(uuid)'),
      ('public.list_employee_check_in_workspace()', 'public.list_employee_check_in_workspace()'),
      ('public.list_employee_check_in_workspace_for_preview(uuid)', 'public.list_employee_check_in_workspace_for_preview(uuid)')
    ) expected(signature, procedure_name)
    join pg_proc p on p.oid = expected.procedure_name::regprocedure
    join pg_language language on language.oid = p.prolang
    order by expected.signature
    """)
    require(len(functions) == len(PREDECESSOR_FUNCTIONS), "Reviewed Check-In predecessor functions are missing")
    for function in functions:
        filename, header, language = PREDECESSOR_FUNCTIONS[function["signature"]]
        require(
            function["prosrc"] == reviewed_function_body(filename, header),
            f"Check-In predecessor function drift: {function['signature']}",
        )
        require(
            function["prosecdef"]
            and function["proconfig"] == ['search_path=""']
            and function["lanname"] == language
            and function["provolatile"] == "s",
            f"Check-In predecessor function security differs: {function['signature']}",
        )

    access = query("""select
      not has_function_privilege('anon','private.can_view_employee_check_in(uuid)','EXECUTE') as private_anonymous_denied,
      not has_function_privilege('authenticated','private.can_view_employee_check_in(uuid)','EXECUTE') as private_authenticated_denied,
      not has_function_privilege('anon','public.list_employee_check_in_register()','EXECUTE') as register_anonymous_denied,
      has_function_privilege('authenticated','public.list_employee_check_in_register()','EXECUTE') as register_authenticated,
      not has_function_privilege('anon','public.list_employee_check_in_workspace()','EXECUTE') as workspace_anonymous_denied,
      has_function_privilege('authenticated','public.list_employee_check_in_workspace()','EXECUTE') as workspace_authenticated,
      has_function_privilege('service_role','public.list_employee_check_in_workspace()','EXECUTE') as workspace_service_role,
      not has_function_privilege('anon','public.list_employee_check_in_workspace_for_preview(uuid)','EXECUTE') as preview_anonymous_denied,
      has_function_privilege('authenticated','public.list_employee_check_in_workspace_for_preview(uuid)','EXECUTE') as preview_authenticated,
      has_function_privilege('service_role','public.list_employee_check_in_workspace_for_preview(uuid)','EXECUTE') as preview_service_role
    """)[0]
    require(all(access.values()), "Check-In predecessor function ACLs differ")
    print(json.dumps({
        "verifiedPredecessorFunctions": sorted(PREDECESSOR_FUNCTIONS),
        "verifiedPredecessorAccess": access,
    }))


def verify_schema():
    state = query("""select
      (select relrowsecurity and relforcerowsecurity
       from pg_class where oid='private.employee_check_in_reviews'::regclass) as reviews_rls,
      not has_table_privilege('authenticated','private.employee_check_in_reviews','SELECT') as reviews_private,
      has_function_privilege('authenticated','public.record_employee_check_in_review(uuid,text,date,text,bigint)','EXECUTE') as reviewer_rpc_granted,
      not has_function_privilege('anon','public.record_employee_check_in_review(uuid,text,date,text,bigint)','EXECUTE') as anonymous_denied,
      (select p.prosecdef and p.proconfig = array['search_path=""']
       from pg_proc p where p.oid='public.record_employee_check_in_review(uuid,text,date,text,bigint)'::regprocedure) as rpc_hardened,
      position('reviewOutcome' in pg_get_functiondef('public.list_employee_check_in_register()'::regprocedure))>0 as register_projects_review,
      position('reviewOutcome' in pg_get_functiondef('public.list_employee_check_in_workspace()'::regprocedure))>0 as workspace_projects_review,
      position('reviewOutcome' in pg_get_functiondef('public.list_employee_check_in_workspace_for_preview(uuid)'::regprocedure))>0 as preview_projects_review,
      position('raw_app_meta_data' in pg_get_functiondef('public.list_employee_check_in_workspace_for_preview(uuid)'::regprocedure))=0 as preview_ignores_legacy_claims,
      position('employee_check_in_access_grants' in pg_get_functiondef('public.list_employee_check_in_workspace_for_preview(uuid)'::regprocedure))=0 as preview_ignores_legacy_grants
    """)[0]
    require(all(state.values()), "Deployed Check-In review schema verification failed")
    print(json.dumps(state))


operation = sys.argv[1] if len(sys.argv) > 1 else ""
require(operation in ("inspect", "apply", "advisors"), "Use inspect, advisors or apply <reviewed-sha256>")
project = api("")
require(project["id"] == PROJECT and project["organization_id"] == ORGANISATION, "MAM target mismatch")
print(json.dumps({"verifiedProject": PROJECT}))

if operation == "advisors":
    for category in ("security", "performance"):
        data = api("/advisors/" + category)
        counts = {}
        for lint in data.get("lints", []):
            key = lint.get("name", "unknown") + ":" + lint.get("level", "unknown")
            counts[key] = counts.get(key, 0) + 1
        print(json.dumps({"category": category, "counts": counts}))
    sys.exit(0)

sql = MIGRATION.read_text()
if operation == "apply":
    require(len(sys.argv) == 3 and hashlib.sha256(sql.encode()).hexdigest() == sys.argv[2], "Reviewed migration differs")

base = query("select version from supabase_migrations.schema_migrations where version in ('20260826090000','20260923210000')")
base_versions = sorted(row["version"] for row in base)
print(json.dumps({"predecessorMigrations": base_versions}))
require("20260923210000" in base_versions, "Latest reviewed Check-In predecessor migration is missing")
prerequisites = query("""select
  to_regclass('private.employee_check_in_reminders') is not null as reminders,
  to_regclass('private.employee_check_in_reminder_events') is not null as reminder_events,
  to_regprocedure('private.can_view_employee_check_in(uuid)') is not null as scoped_access,
  to_regprocedure('public.list_employee_check_in_register()') is not null as register_projection,
  to_regprocedure('public.list_employee_check_in_workspace()') is not null as workspace_projection,
  to_regprocedure('public.list_employee_check_in_workspace_for_preview(uuid)') is not null as preview_projection,
  (select count(*) = 14
   from information_schema.columns
   where table_schema = 'private'
     and table_name = 'employee_check_in_reminders'
     and column_name in (
       'id','person_id','milestone','due_date','reminder_sequence','delivery_status',
       'completed_at','completed_by','updated_at','claim_token','claimed_at',
       'next_attempt_at','manual_catch_up_requested_at','needs_review_reason'
     )) as reminder_columns,
  (select count(*) = 3
   from information_schema.columns
   where table_schema = 'private'
     and table_name = 'employee_check_in_reminder_events'
     and column_name in ('reminder_id','event_type','actor_user_id')) as event_columns
""")[0]
require(all(prerequisites.values()), "Check-In review prerequisites are missing")
existing = query("select statements from supabase_migrations.schema_migrations where version=" + literal(VERSION))
if existing:
    require(existing[0]["statements"] == [sql], "Recorded migration differs")
else:
    verify_predecessor_functions()
print(json.dumps({"migrationRecorded": bool(existing), "prerequisites": prerequisites}))

if operation == "apply" and not existing:
    require(sql.count("\ncommit;") == 1, "Unexpected migration transaction structure")
    history = "insert into supabase_migrations.schema_migrations(version,name,statements) values(" + literal(VERSION) + "," + literal(NAME) + ",ARRAY[" + literal(sql) + "]);"
    release = sql.replace(
        "begin;",
        "begin;\nset local lock_timeout='5s';\nset local statement_timeout='75s';",
        1,
    ).replace("\ncommit;", "\n" + history + "\nnotify pgrst,'reload schema';\ncommit;")
    query(release)

if existing or operation == "apply":
    verify_schema()
