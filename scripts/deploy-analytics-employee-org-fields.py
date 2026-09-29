import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.request

PROJECT = "xtwlrjqbusadghavchqm"
ORGANISATION = "fwlmbmospuwoaosffvmw"
BASE_VERSION = "20260925030000"
BASE_NAME = "analytics_employee_names"
VERSION = "20260929140000"
NAME = "analytics_employee_org_fields"
ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / f"{VERSION}_{NAME}.sql"
BASE_MIGRATION = ROOT / "supabase" / "migrations" / f"{BASE_VERSION}_{BASE_NAME}.sql"
RPC = "public.analytics_dashboard_dataset(text,date,date,integer,integer)"
NEW_PROJECTION = (
    "team", "scheduled_employment_end_date", "employment_type", "contract_type",
    "working_weekdays", "working_day_times",
)


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


def migration_files():
    return {
        file.name[:14]: file.name[15:-4]
        for file in (ROOT / "supabase" / "migrations").glob("*.sql")
    }


def schema_state():
    return query(f"""
select
  p.proowner = 'postgres'::regrole as expected_owner,
  (owner_role.rolsuper or owner_role.rolbypassrls) as trusted_owner,
  p.prosecdef as security_definer,
  p.provolatile = 's' as stable_function,
  p.proconfig = array['search_path=""']::text[] as empty_search_path,
  has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_execute,
  not has_function_privilege('anon', p.oid, 'EXECUTE') as anon_denied,
  not has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_denied,
  not exists (
    select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
    where privilege.privilege_type = 'EXECUTE'
      and (privilege.is_grantable
        or privilege.grantee not in (p.proowner, 'service_role'::regrole::oid))
  ) as execute_acl_restricted,
  (select count(*) = 6 from information_schema.columns
   where table_schema = 'private' and table_name = 'employee_directory_details'
     and column_name in ('person_id','team_name','scheduled_employment_end_date',
       'employment_type','working_weekdays','working_day_times')) as directory_columns,
  (select count(*) = 2 from information_schema.columns
   where table_schema = 'private' and table_name = 'employee_check_in_contract_classifications'
     and column_name in ('person_id','contract_type')) as contract_columns,
  (select relrowsecurity from pg_class where oid = to_regclass('private.employee_directory_details'))
    as directory_rls,
  (select relrowsecurity from pg_class where oid = to_regclass('private.employee_check_in_contract_classifications'))
    as contract_rls,
  not has_table_privilege('anon','private.employee_directory_details','SELECT')
    and not has_table_privilege('authenticated','private.employee_directory_details','SELECT')
    and not has_table_privilege('service_role','private.employee_directory_details','SELECT')
    and not has_table_privilege('anon','private.employee_check_in_contract_classifications','SELECT')
    and not has_table_privilege('authenticated','private.employee_check_in_contract_classifications','SELECT')
    and not has_table_privilege('service_role','private.employee_check_in_contract_classifications','SELECT')
    as private_sources_unreadable,
  ((length(pg_get_functiondef(p.oid)) - length(replace(pg_get_functiondef(p.oid),
    $anchor$'last_name', (select employee_detail.last_name from private.employee_directory_details employee_detail where employee_detail.person_id = person.id),
          'company', person.company_key,$anchor$, ''))) /
    length($anchor$'last_name', (select employee_detail.last_name from private.employee_directory_details employee_detail where employee_detail.person_id = person.id),
          'company', person.company_key,$anchor$)) = 1 as expected_projection_anchor,
  (
    position($$'team', (select employee_detail.team_name from private.employee_directory_details employee_detail where employee_detail.person_id = person.id)$$ in pg_get_functiondef(p.oid)) > 0
    and position($$'scheduled_employment_end_date', (select employee_detail.scheduled_employment_end_date from private.employee_directory_details employee_detail where employee_detail.person_id = person.id)$$ in pg_get_functiondef(p.oid)) > 0
    and position($$'employment_type', (select employee_detail.employment_type from private.employee_directory_details employee_detail where employee_detail.person_id = person.id)$$ in pg_get_functiondef(p.oid)) > 0
    and position($$'contract_type', (select classification.contract_type from private.employee_check_in_contract_classifications classification where classification.person_id = person.id)$$ in pg_get_functiondef(p.oid)) > 0
    and position($$'working_weekdays', (select employee_detail.working_weekdays from private.employee_directory_details employee_detail where employee_detail.person_id = person.id)$$ in pg_get_functiondef(p.oid)) > 0
    and position($$'working_day_times', coalesce((select employee_detail.working_day_times from private.employee_directory_details employee_detail where employee_detail.person_id = person.id), '[]'::jsonb))$$ in pg_get_functiondef(p.oid)) > 0
  ) as fields_projected,
  (
    position($$'team', (select employee_detail.team_name from private.employee_directory_details employee_detail where employee_detail.person_id = person.id)$$ in pg_get_functiondef(p.oid)) = 0
    and position($$'scheduled_employment_end_date', (select employee_detail.scheduled_employment_end_date from private.employee_directory_details employee_detail where employee_detail.person_id = person.id)$$ in pg_get_functiondef(p.oid)) = 0
    and position($$'employment_type', (select employee_detail.employment_type from private.employee_directory_details employee_detail where employee_detail.person_id = person.id)$$ in pg_get_functiondef(p.oid)) = 0
    and position($$'contract_type', (select classification.contract_type from private.employee_check_in_contract_classifications classification where classification.person_id = person.id)$$ in pg_get_functiondef(p.oid)) = 0
    and position($$'working_weekdays', (select employee_detail.working_weekdays from private.employee_directory_details employee_detail where employee_detail.person_id = person.id)$$ in pg_get_functiondef(p.oid)) = 0
    and position($$'working_day_times', coalesce((select employee_detail.working_day_times from private.employee_directory_details employee_detail where employee_detail.person_id = person.id), '[]'::jsonb))$$ in pg_get_functiondef(p.oid)) = 0
  ) as fields_not_preprojected
from pg_proc p join pg_roles owner_role on owner_role.oid = p.proowner
where p.oid = to_regprocedure({literal(RPC)})
""")[0]


def main():
    operation = sys.argv[1] if len(sys.argv) > 1 else ""
    require(operation in ("inspect", "apply"), "Use inspect or apply <reviewed-sha256>")
    sql = MIGRATION.read_text()
    base_sql = BASE_MIGRATION.read_text()
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

    local = migration_files()
    remote_rows = query("select version,name from supabase_migrations.schema_migrations order by version")
    remote = {row["version"]: row["name"] for row in remote_rows}
    remote_only = set(remote) - set(local)
    local_only = set(local) - set(remote)
    name_mismatches = [version for version in set(local) & set(remote) if local[version] != remote[version]]
    require(not name_mismatches, "Migration names differ for shared versions; stop and reconcile provenance")
    require(VERSION in local and local[VERSION] == NAME, "Target migration file/version mismatch")
    later_local_only = sorted(version for version in local_only if version > VERSION)
    require(not later_local_only, "A later local migration is absent from the remote ledger")
    base = query(
        "select version,name,statements from supabase_migrations.schema_migrations where version="
        + literal(BASE_VERSION)
    )
    require(
        len(base) == 1 and base[0]["name"] == BASE_NAME and base[0]["statements"] == [base_sql],
        "Expected Analytics employee-name predecessor is not recorded with its exact source",
    )

    existing = query(
        "select version,name,statements from supabase_migrations.schema_migrations where version="
        + literal(VERSION)
    )
    if existing:
        require(
            len(existing) == 1
            and existing[0]["name"] == NAME
            and existing[0]["statements"] == [sql],
            "Recorded Analytics employee-org-fields migration differs from reviewed source",
        )
    else:
        require(max(remote) < VERSION, "Target migration version is not newer than the remote ledger")

    state = schema_state()
    if existing:
        require(state["fields_projected"], "Migration is recorded but requested employee fields are not projected")
    else:
        require(state["fields_not_preprojected"], "Requested fields are already projected without the expected migration record")
        require(state["expected_projection_anchor"], "Live Analytics projection differs from the reviewed predecessor")

    safe = all(
        state[key]
        for key in (
            "expected_owner", "trusted_owner", "security_definer", "stable_function",
            "empty_search_path", "service_role_execute", "anon_denied",
            "authenticated_denied", "execute_acl_restricted", "directory_columns",
            "contract_columns", "directory_rls", "contract_rls", "private_sources_unreadable",
        )
    )
    require(safe, "Live Analytics RPC or private HR schema does not match the reviewed security boundary")

    print(json.dumps({
        "verifiedProject": PROJECT,
        "migrationRecorded": bool(existing),
        "ledger": {
            "remoteCount": len(remote),
            "localCount": len(local),
            "remoteOnlyCount": len(remote_only),
            "localOnlyCount": len(local_only),
            "sharedNameMismatches": len(name_mismatches),
            "targetNewerThanRemote": max(remote) < VERSION,
        },
        "schema": state,
    }, indent=2))
    if operation == "inspect" or existing:
        return

    require(sql.startswith("begin;\n") and sql.count("\ncommit;") == 1, "Unexpected migration transaction structure")
    history = (
        "insert into supabase_migrations.schema_migrations(version,name,statements) values("
        + literal(VERSION) + "," + literal(NAME) + ",ARRAY[" + literal(sql) + "]);"
    )
    release_sql = sql.replace(
        "begin;", "begin;\nset local lock_timeout='5s';\nset local statement_timeout='75s';", 1
    ).replace(
        "\ncommit;", "\n" + history + "\nnotify pgrst,'reload schema';\ncommit;", 1
    )
    query(release_sql)
    final_state = schema_state()
    require(final_state["fields_projected"], "Post-migration field projection verification failed")
    require(all(final_state[key] for key in (
        "expected_owner", "trusted_owner", "security_definer", "stable_function",
        "empty_search_path", "service_role_execute", "anon_denied",
        "authenticated_denied", "execute_acl_restricted", "directory_columns",
        "contract_columns", "directory_rls", "contract_rls", "private_sources_unreadable",
    )), "Post-migration security verification failed")
    recorded = query(
        "select version,name,statements from supabase_migrations.schema_migrations where version="
        + literal(VERSION)
    )
    require(
        len(recorded) == 1 and recorded[0]["name"] == NAME and recorded[0]["statements"] == [sql],
        "Applied migration did not record its exact reviewed source",
    )
    print(json.dumps({"migrationApplied": VERSION, "verified": True}, indent=2))


if __name__ == "__main__":
    main()
