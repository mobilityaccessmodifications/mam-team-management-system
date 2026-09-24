import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request


PROJECT = "xtwlrjqbusadghavchqm"
ORGANISATION = "fwlmbmospuwoaosffvmw"
BASE_VERSION = "20260916150000"
VERSION = "20260924235000"
NAME = "powerbi_hr_employee_directory"
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
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"Supabase Management API returned HTTP {error.code}: {detail[:1000]}"
        ) from error


def query(statement):
    return api("/database/query", {"query": statement})


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def schema_status():
    return query(
        """
select
  exists (
    select 1 from pg_roles
    where rolname = 'mam_powerbi_hr_reader'
      and rolcanlogin
      and not rolsuper
      and not rolcreatedb
      and not rolcreaterole
      and not rolinherit
      and not rolreplication
      and not rolbypassrls
  ) as role_is_limited,
  has_database_privilege('mam_powerbi_hr_reader', current_database(), 'CONNECT') as database_connect,
  not exists (
    select 1
    from pg_auth_members membership
    where membership.member = (
      select oid from pg_roles where rolname = 'mam_powerbi_hr_reader'
    )
  ) as no_role_membership,
  has_schema_privilege('mam_powerbi_hr_reader', 'powerbi_hr', 'USAGE') as schema_usage,
  not has_schema_privilege('mam_powerbi_hr_reader', 'powerbi_hr', 'CREATE') as schema_is_read_only,
  has_table_privilege('mam_powerbi_hr_reader', 'powerbi_hr.employee_directory', 'SELECT') as view_select,
  not has_table_privilege('mam_powerbi_hr_reader', 'powerbi_hr.employee_directory', 'INSERT')
    and not has_table_privilege('mam_powerbi_hr_reader', 'powerbi_hr.employee_directory', 'UPDATE')
    and not has_table_privilege('mam_powerbi_hr_reader', 'powerbi_hr.employee_directory', 'DELETE')
    and not has_table_privilege('mam_powerbi_hr_reader', 'powerbi_hr.employee_directory', 'TRUNCATE')
    and not has_table_privilege('mam_powerbi_hr_reader', 'powerbi_hr.employee_directory', 'REFERENCES')
    and not has_table_privilege('mam_powerbi_hr_reader', 'powerbi_hr.employee_directory', 'TRIGGER') as view_is_read_only,
  not has_table_privilege('mam_powerbi_hr_reader', 'public.internal_org_people', 'SELECT')
    and not has_table_privilege('mam_powerbi_hr_reader', 'private.employee_directory_details', 'SELECT')
    and not has_schema_privilege('mam_powerbi_hr_reader', 'private', 'USAGE') as source_tables_are_private,
  not exists (
    select 1
    from pg_class relation
    join pg_namespace schema on schema.oid = relation.relnamespace
    where schema.nspname not in ('pg_catalog', 'information_schema')
      and schema.nspname not like 'pg_temp_%'
      and relation.relkind in ('r', 'p', 'v', 'm', 'f')
      and relation.oid <> to_regclass('powerbi_hr.employee_directory')
      and not (
        schema.nspname = 'extensions'
        and relation.relname in ('pg_stat_statements', 'pg_stat_statements_info')
      )
      and (
        has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'SELECT')
        or has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'INSERT')
        or has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'UPDATE')
        or has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'DELETE')
        or has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'TRUNCATE')
        or has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'REFERENCES')
        or has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'TRIGGER')
      )
  ) as no_other_business_relation_access,
  not exists (
    select 1
    from pg_class relation
    join pg_namespace schema on schema.oid = relation.relnamespace
    where schema.nspname = 'extensions'
      and relation.relname in ('pg_stat_statements', 'pg_stat_statements_info')
      and (
        has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'INSERT')
        or has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'UPDATE')
        or has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'DELETE')
        or has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'TRUNCATE')
        or has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'REFERENCES')
        or has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'TRIGGER')
      )
  ) as shared_statistics_views_are_read_only,
  not exists (
    select 1
    from pg_class sequence
    join pg_namespace schema on schema.oid = sequence.relnamespace
    where schema.nspname not in ('pg_catalog', 'information_schema')
      and schema.nspname not like 'pg_temp_%'
      and sequence.relkind = 'S'
      and (
        has_sequence_privilege('mam_powerbi_hr_reader', sequence.oid, 'USAGE')
        or has_sequence_privilege('mam_powerbi_hr_reader', sequence.oid, 'SELECT')
        or has_sequence_privilege('mam_powerbi_hr_reader', sequence.oid, 'UPDATE')
      )
  ) as no_sequence_access,
  not exists (
    select 1
    from pg_proc routine
    join pg_namespace schema on schema.oid = routine.pronamespace
    where has_schema_privilege('mam_powerbi_hr_reader', schema.oid, 'USAGE')
      and routine.prosecdef
      and has_function_privilege('mam_powerbi_hr_reader', routine.oid, 'EXECUTE')
  ) as no_security_definer_routines,
  not has_schema_privilege('service_role', 'powerbi_hr', 'USAGE')
    and not has_table_privilege('service_role', 'powerbi_hr.employee_directory', 'SELECT')
    and not has_schema_privilege('anon', 'powerbi_hr', 'USAGE')
    and not has_table_privilege('anon', 'powerbi_hr.employee_directory', 'SELECT')
    and not has_schema_privilege('authenticated', 'powerbi_hr', 'USAGE')
    and not has_table_privilege('authenticated', 'powerbi_hr.employee_directory', 'SELECT') as app_roles_not_granted,
  (
    select array_agg(column_name::text order by ordinal_position)
    from information_schema.columns
    where table_schema = 'powerbi_hr'
      and table_name = 'employee_directory'
  ) = array[
    'employee_id', 'first_name', 'last_name', 'full_name', 'company_key',
    'position_title', 'is_active', 'started_date', 'created_at', 'updated_at',
    'detail_updated_at', 'scheduled_employment_end_date', 'employment_type',
    'working_weekdays', 'working_day_times', 'reason_for_leaving'
  ]::text[] as projection_is_exact,
  exists (
    select 1 from pg_class relation
    where relation.oid = to_regclass('powerbi_hr.employee_directory')
      and relation.reloptions @> array['security_barrier=true']
  ) as security_barrier,
  exists (
    select 1
    from pg_db_role_setting settings
    cross join lateral unnest(settings.setconfig) as config(value)
    where settings.setrole = (
      select oid from pg_roles where rolname = 'mam_powerbi_hr_reader'
    )
      and config.value = 'default_transaction_read_only=on'
  ) as read_only_default,
  exists (
    select 1
    from pg_db_role_setting settings
    cross join lateral unnest(settings.setconfig) as config(value)
    where settings.setrole = (
      select oid from pg_roles where rolname = 'mam_powerbi_hr_reader'
    )
      and config.value = 'statement_timeout=60s'
  ) as bounded_query_time
"""
    )[0]


def unexpected_relation_access():
    return query(
        """
select coalesce(
  json_agg(
    json_build_object(
      'schema', schema.nspname,
      'relation', relation.relname,
      'kind', relation.relkind,
      'select', has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'SELECT'),
      'insert', has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'INSERT'),
      'update', has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'UPDATE'),
      'delete', has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'DELETE'),
      'truncate', has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'TRUNCATE')
    ) order by schema.nspname, relation.relname
  ),
  '[]'::json
) as relations
from pg_class relation
join pg_namespace schema on schema.oid = relation.relnamespace
where schema.nspname not in ('pg_catalog', 'information_schema')
  and schema.nspname not like 'pg_temp_%'
  and relation.relkind in ('r', 'p', 'v', 'm', 'f')
  and relation.oid <> to_regclass('powerbi_hr.employee_directory')
  and not (
    schema.nspname = 'extensions'
    and relation.relname in ('pg_stat_statements', 'pg_stat_statements_info')
  )
  and (
    has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'SELECT')
    or has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'INSERT')
    or has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'UPDATE')
    or has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'DELETE')
    or has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'TRUNCATE')
    or has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'REFERENCES')
    or has_table_privilege('mam_powerbi_hr_reader', relation.oid, 'TRIGGER')
  )
"""
    )[0]["relations"]


def main():
    project = api("")
    require(
        project["id"] == PROJECT and project["organization_id"] == ORGANISATION,
        "MAM Supabase target mismatch",
    )
    print("Verified MAM project", PROJECT)

    operation = sys.argv[1] if len(sys.argv) > 1 else ""
    require(operation in {"inspect", "apply"}, "Use inspect or apply <sha256>")
    require(len(sys.argv) == (2 if operation == "inspect" else 3), "Unexpected arguments")

    base = query(
        "select version from supabase_migrations.schema_migrations where version = "
        + literal(BASE_VERSION)
    )
    existing = query(
        "select version, statements from supabase_migrations.schema_migrations where version = "
        + literal(VERSION)
    )

    if operation == "inspect":
        result = {
            "hrWorkScheduleMigrationRecorded": bool(base),
            "powerBiMigrationRecorded": bool(existing),
        }
        if existing:
            require(existing[0]["statements"] == [MIGRATION.read_text()], "Recorded migration differs")
            status = schema_status()
            result["schema"] = status
            if not status["no_other_business_relation_access"]:
                result["unexpectedRelationAccess"] = unexpected_relation_access()
        print(json.dumps(result, indent=2))
        return

    sql = MIGRATION.read_text()
    require(hashlib.sha256(sql.encode()).hexdigest() == sys.argv[2], "Reviewed migration differs")
    require(bool(base), "The work-schedule migration is not recorded")
    if existing:
        require(existing[0]["statements"] == [sql], "Recorded migration differs")
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
        ).replace("\ncommit;", "\n" + history + "\ncommit;")
        query(release_sql)

    status = schema_status()
    require(all(status.values()), "Deployed Power BI HR schema or grants are incomplete")
    print("Verified the Power BI HR read-only projection and grants")


if __name__ == "__main__":
    main()
