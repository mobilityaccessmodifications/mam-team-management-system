"""Hash-pinned, single-migration MAM Analytics API release.

Run only through the MAM credential helper:
  ... exec supabase -- python3 scripts/deploy-analytics-employee-names.py inspect
  ... exec supabase -- python3 scripts/deploy-analytics-employee-names.py apply <sha256>

This applies only the named migration transactionally through the approved
Management API database-query route; it does not reconcile unrelated migration
history or use `supabase db push`. Output contains schema flags only.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.request

PROJECT = "xtwlrjqbusadghavchqm"
ORGANISATION = "fwlmbmospuwoaosffvmw"
BASE_VERSION = "20260904022514"
BASE_NAME = "20260904110000_analytics_dashboard_api"
VERSION = "20260925030000"
NAME = "analytics_employee_names"
ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / f"{VERSION}_{NAME}.sql"
RPC = "public.analytics_dashboard_dataset(text,date,date,integer,integer)"


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
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.load(response)


def query(sql):
    return api("/database/query", {"query": sql})


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def schema_state():
    return query(f"""
select
  (select count(*) = 3
   from pg_attribute
   where attrelid = to_regclass('private.employee_directory_details')
     and attname in ('person_id', 'first_name', 'last_name')
     and not attisdropped) as employee_name_columns,
  p.proowner = 'postgres'::regrole as expected_owner,
  p.prosecdef as security_definer,
  p.provolatile = 's' as stable_function,
  p.proconfig = array['search_path=""']::text[] as empty_search_path,
  has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_execute,
  not has_function_privilege('anon', p.oid, 'EXECUTE') as anon_denied,
  not has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_denied,
  not exists (
    select 1
    from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
    where privilege.privilege_type = 'EXECUTE'
      and (privilege.is_grantable
        or privilege.grantee not in (p.proowner, 'service_role'::regrole::oid))
  ) as execute_acl_restricted,
  position($$'employee_id', person.id,$$ in pg_get_functiondef(p.oid)) > 0
    and position($$'company', person.company_key,$$ in pg_get_functiondef(p.oid)) > 0
    as employee_projection_anchor,
  position($$'first_name'$$ in pg_get_functiondef(p.oid)) > 0
    and position($$'last_name'$$ in pg_get_functiondef(p.oid)) > 0 as names_projected
from pg_proc p
where p.oid = to_regprocedure({literal(RPC)})
""")[0]


def main():
    operation = sys.argv[1] if len(sys.argv) > 1 else ""
    require(operation in ("inspect", "apply"), "Use inspect or apply <reviewed-sha256>")
    sql = MIGRATION.read_text()
    if operation == "apply":
        require(
            len(sys.argv) == 3 and hashlib.sha256(sql.encode()).hexdigest() == sys.argv[2],
            "Reviewed migration differs",
        )

    project = api("")
    require(
        project.get("id") == PROJECT and project.get("organization_id") == ORGANISATION,
        "MAM Supabase target mismatch",
    )
    base = query(
        "select version,name from supabase_migrations.schema_migrations where version="
        + literal(BASE_VERSION)
        + " and name="
        + literal(BASE_NAME)
    )
    require(len(base) == 1, "Expected Analytics API predecessor migration is not recorded exactly once")

    existing = query(
        "select version,name,statements from supabase_migrations.schema_migrations where version="
        + literal(VERSION)
    )
    if existing:
        require(
            len(existing) == 1
            and existing[0]["name"] == NAME
            and existing[0]["statements"] == [sql],
            "Recorded Analytics employee-name migration differs from reviewed source",
        )

    state = schema_state()
    if existing:
        require(state["names_projected"], "Migration is recorded but employee names are not projected")
    else:
        require(not state["names_projected"], "Names are already projected without the expected migration record")
        require(state["employee_projection_anchor"], "Live Analytics employee projection differs from reviewed predecessor")

    safe = all(
        state[key]
        for key in (
            "employee_name_columns",
            "expected_owner",
            "security_definer",
            "stable_function",
            "empty_search_path",
            "service_role_execute",
            "anon_denied",
            "authenticated_denied",
            "execute_acl_restricted",
        )
    )
    require(safe, "Live Analytics RPC or private-name schema does not match the reviewed security boundary")

    print(json.dumps({"verifiedProject": PROJECT, "migrationRecorded": bool(existing), "schema": state}, indent=2))
    if operation == "inspect" or existing:
        return

    require(sql.startswith("begin;\n") and sql.count("\ncommit;") == 1, "Unexpected migration transaction structure")
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
        1,
    )
    query(release_sql)
    final_state = schema_state()
    require(all(final_state.values()), "Post-migration verification failed")
    recorded = query(
        "select version,name,statements from supabase_migrations.schema_migrations where version="
        + literal(VERSION)
    )
    require(
        len(recorded) == 1
        and recorded[0]["name"] == NAME
        and recorded[0]["statements"] == [sql],
        "Applied migration did not record its exact reviewed source",
    )
    require(query("select version from supabase_migrations.schema_migrations where version=" + literal(VERSION)),
            "Applied migration ledger row could not be read back")
    print(json.dumps({"migrationApplied": VERSION, "verified": final_state}, indent=2))


if __name__ == "__main__":
    main()
