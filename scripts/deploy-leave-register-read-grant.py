"""Inspect/apply the MAM Leave-register read migration, then grant one active Jackie account.

Run only via the repository's MAM Supabase credential helper. No staff data is printed.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.request

PROJECT = "xtwlrjqbusadghavchqm"
ORGANISATION = "fwlmbmospuwoaosffvmw"
VERSION = "20260929133000"
NAME = "leave_register_read_grants"
MIGRATION = Path(__file__).resolve().parents[1] / "supabase" / "migrations" / f"{VERSION}_{NAME}.sql"
MIGRATIONS = MIGRATION.parent
PREDECESSORS = {
    "public.list_leave_workspace_requests()": "20260904140000_historical_leave_import_support.sql",
    "private.can_view_leave_request_attachment(uuid)": "20260907051607_priority_leave_workflows.sql",
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
    require(len(functions) == len(PREDECESSORS), "Leave predecessor functions missing")
    for function in functions:
        signature = function["signature"]
        require(signature in PREDECESSORS, "Unexpected Leave predecessor")
        require(function["prosrc"] in (MIGRATIONS / PREDECESSORS[signature]).read_text(),
                "Leave predecessor drift: " + signature)
        require(function["prosecdef"] and function["proconfig"] == ['search_path=""'],
                "Leave predecessor security drift: " + signature)
    state = query("""select
      not has_function_privilege('authenticated','private.can_view_leave_request_attachment(uuid)','EXECUTE') as evidence_private,
      not has_function_privilege('anon','public.list_leave_workspace_requests()','EXECUTE') as anonymous_denied,
      has_function_privilege('authenticated','public.list_leave_workspace_requests()','EXECUTE') as request_enabled,
      has_function_privilege('authenticated','public.list_leave_workspace_attachments()','EXECUTE') as metadata_enabled,
      has_function_privilege('authenticated','public.can_download_leave_request_attachment(uuid)','EXECUTE') as download_enabled""")[0]
    require(all(state.values()), "Leave predecessor ACL drift")


def verify_schema(sql):
    functions = query("""select n.nspname,p.proname,p.prosrc,p.prosecdef,p.proconfig
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where (n.nspname='private' and p.proname in
        ('has_leave_register_read_grant','can_view_leave_request_attachment'))
         or (n.nspname='public' and p.proname in
        ('can_view_all_leave_requests','list_leave_workspace_requests'))""")
    require(len(functions) == 4, "Expected Leave register functions missing")
    for function in functions:
        require(function["prosrc"] in sql, "Deployed Leave register function differs")
        require(function["prosecdef"] and function["proconfig"] == ['search_path=""'],
                "Leave register function security differs")
    state = query("""select
      (select relrowsecurity from pg_class where oid='private.leave_register_read_grants'::regclass) as grant_rls,
      not has_table_privilege('authenticated','private.leave_register_read_grants','SELECT') as grant_private,
      not has_table_privilege('authenticated','private.leave_register_read_grants','INSERT') as grant_write_private,
      not has_function_privilege('authenticated','private.has_leave_register_read_grant(uuid)','EXECUTE') as helper_private,
      not has_function_privilege('anon','public.can_view_all_leave_requests()','EXECUTE') as anonymous_denied,
      has_function_privilege('authenticated','public.can_view_all_leave_requests()','EXECUTE') as viewer_enabled,
      has_function_privilege('authenticated','public.list_leave_workspace_requests()','EXECUTE') as request_enabled""")[0]
    require(all(state.values()), "Leave register ACL verification failed")
    print(json.dumps({"schemaVerified": True}))


def jackie_state():
    rows = query("""select count(*) as candidates,
      count(*) filter (where profile.app_role='employee') as employees,
      count(*) filter (where exists (select 1 from private.leave_approval_grants g
        where g.reviewer_user_id=person.auth_user_id)) as reviewers,
      count(*) filter (where grant_row.person_id is not null) as granted
      from public.internal_org_people person
      join public.profiles profile on profile.id=person.auth_user_id
      left join private.leave_register_read_grants grant_row on grant_row.person_id=person.id
      where person.full_name ilike 'Jackie%'
        and person.node_kind='person' and person.is_active
        and profile.account_status='active' and profile.login_name is not null""")
    require(len(rows) == 1, "Account inspection failed")
    state = rows[0]
    require(int(state["candidates"]) == 1 and int(state["employees"]) == 1
            and int(state["reviewers"]) == 0, "Jackie account is not unique, active, employee-only and reviewer-free")
    return int(state["granted"])


def main():
    operation = sys.argv[1] if len(sys.argv) > 1 else ""
    require(operation in ("inspect", "apply", "grant"), "Use inspect, apply <reviewed-sha256>, or grant <reviewed-sha256>")
    require(len(sys.argv) == (2 if operation == "inspect" else 3), "Missing reviewed migration hash")
    sql = MIGRATION.read_text()
    if operation != "inspect":
        require(hashlib.sha256(sql.encode()).hexdigest() == sys.argv[2], "Reviewed migration differs")
    project = api("")
    require(project["id"] == PROJECT and project["organization_id"] == ORGANISATION,
            "MAM Supabase target mismatch")
    base = query("select version from supabase_migrations.schema_migrations where version='20260929120000'")
    require(bool(base), "Staff Calendar predecessor missing")
    existing = query("select statements from supabase_migrations.schema_migrations where version=" + literal(VERSION))
    if existing:
        require(existing[0]["statements"] == [sql], "Recorded Leave migration differs")
        verify_schema(sql)
    else:
        require(operation != "grant", "Apply reviewed migration before granting access")
        verify_predecessors()
    if operation == "apply" and not existing:
        require(sql.startswith("begin;\n") and sql.count("\ncommit;") == 1,
                "Unexpected transaction structure")
        history = "insert into supabase_migrations.schema_migrations(version,name,statements) values(" + literal(VERSION) + "," + literal(NAME) + ",ARRAY[" + literal(sql) + "]);"
        release = sql.replace("begin;", "begin;\nset local lock_timeout='5s';\nset local statement_timeout='75s';", 1).replace("\ncommit;", "\n" + history + "\nnotify pgrst,'reload schema';\ncommit;")
        query(release)
        existing = query("select statements from supabase_migrations.schema_migrations where version=" + literal(VERSION))
        require(len(existing) == 1 and existing[0]["statements"] == [sql], "Applied Leave migration ledger differs")
        verify_schema(sql)
    print(json.dumps({"project": PROJECT, "migrationRecorded": bool(existing)}))
    if existing or operation == "apply":
        granted = jackie_state()
        if operation == "grant" and not granted:
            statement = """begin;
              set local lock_timeout='5s'; set local statement_timeout='20s';
              with candidates as materialized (
                select person.id,
                  profile.app_role='employee'
                    and not exists (select 1 from private.leave_approval_grants g
                      where g.reviewer_user_id=person.auth_user_id) as eligible
                from public.internal_org_people person
                join public.profiles profile on profile.id=person.auth_user_id
                where person.full_name ilike 'Jackie%' and person.node_kind='person'
                  and person.is_active and profile.account_status='active'
                  and profile.login_name is not null
              ), sole as (
                select (array_agg(id))[1] as id from candidates
                having count(*)=1 and bool_and(eligible)
              )
              insert into private.leave_register_read_grants(person_id)
                select id from sole
                on conflict (person_id) do nothing;
              commit;"""
            query(statement)
            granted = jackie_state()
        require(granted == 1 if operation == "grant" else granted in (0, 1), "Unexpected grant state")
        print(json.dumps({"jackieActiveEmployeeVerified": True, "jackieReadGrantPresent": bool(granted)}))


if __name__ == "__main__":
    main()
