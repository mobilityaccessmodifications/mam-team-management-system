import hashlib
import json
import os
import sys
import urllib.error
import urllib.request

PROJECT = "xtwlrjqbusadghavchqm"
ORGANISATION = "fwlmbmospuwoaosffvmw"
VERSION = "20260924235000"
EXPECTED_SOURCE_SHA256 = "5b20229cb418e42f0303100f8dd0051a7f5e3114eee7d3df1d330f87d16369ea"
SCHEMA_KEYS = frozenset([
    "role_is_limited", "database_connect", "no_role_membership", "schema_usage",
    "schema_is_read_only", "view_select", "view_is_read_only", "source_tables_are_private",
    "no_other_business_relation_access", "shared_statistics_views_are_read_only",
    "no_sequence_access", "no_security_definer_routines", "app_roles_not_granted",
    "projection_is_exact", "security_barrier", "read_only_default", "bounded_query_time",
])

SCHEMA_SQL = "select\n  exists (\n    select 1 from pg_roles\n    where rolname = 'mam_powerbi_hr_reader'\n      and rolcanlogin\n      and not rolsuper\n      and not rolcreatedb\n      and not rolcreaterole\n      and not rolinherit\n      and not rolreplication\n      and not rolbypassrls\n  ) as role_is_limited,\n  has_database_privilege(to_regrole('mam_powerbi_hr_reader'), current_database(), 'CONNECT') as database_connect,\n  not exists (\n    select 1\n    from pg_auth_members membership\n    where membership.member = (\n      select oid from pg_roles where rolname = 'mam_powerbi_hr_reader'\n    )\n  ) as no_role_membership,\n  has_schema_privilege(to_regrole('mam_powerbi_hr_reader'), to_regnamespace('powerbi_hr'), 'USAGE') as schema_usage,\n  not has_schema_privilege(to_regrole('mam_powerbi_hr_reader'), to_regnamespace('powerbi_hr'), 'CREATE') as schema_is_read_only,\n  has_table_privilege(to_regrole('mam_powerbi_hr_reader'), to_regclass('powerbi_hr.employee_directory'), 'SELECT') as view_select,\n  not has_table_privilege(to_regrole('mam_powerbi_hr_reader'), to_regclass('powerbi_hr.employee_directory'), 'INSERT')\n    and not has_table_privilege(to_regrole('mam_powerbi_hr_reader'), to_regclass('powerbi_hr.employee_directory'), 'UPDATE')\n    and not has_table_privilege(to_regrole('mam_powerbi_hr_reader'), to_regclass('powerbi_hr.employee_directory'), 'DELETE')\n    and not has_table_privilege(to_regrole('mam_powerbi_hr_reader'), to_regclass('powerbi_hr.employee_directory'), 'TRUNCATE')\n    and not has_table_privilege(to_regrole('mam_powerbi_hr_reader'), to_regclass('powerbi_hr.employee_directory'), 'REFERENCES')\n    and not has_table_privilege(to_regrole('mam_powerbi_hr_reader'), to_regclass('powerbi_hr.employee_directory'), 'TRIGGER') as view_is_read_only,\n  not has_table_privilege(to_regrole('mam_powerbi_hr_reader'), to_regclass('public.internal_org_people'), 'SELECT')\n    and not has_table_privilege(to_regrole('mam_powerbi_hr_reader'), to_regclass('private.employee_directory_details'), 'SELECT')\n    and not has_schema_privilege(to_regrole('mam_powerbi_hr_reader'), to_regnamespace('private'), 'USAGE') as source_tables_are_private,\n  not exists (\n    select 1\n    from pg_class relation\n    join pg_namespace schema on schema.oid = relation.relnamespace\n    where schema.nspname not in ('pg_catalog', 'information_schema')\n      and schema.nspname not like 'pg_temp_%'\n      and relation.relkind in ('r', 'p', 'v', 'm', 'f')\n      and relation.oid <> to_regclass('powerbi_hr.employee_directory')\n      and not (\n        schema.nspname = 'extensions'\n        and relation.relname in ('pg_stat_statements', 'pg_stat_statements_info')\n      )\n      and (\n        has_table_privilege(to_regrole('mam_powerbi_hr_reader'), relation.oid, 'SELECT')\n        or has_table_privilege(to_regrole('mam_powerbi_hr_reader'), relation.oid, 'INSERT')\n        or has_table_privilege(to_regrole('mam_powerbi_hr_reader'), relation.oid, 'UPDATE')\n        or has_table_privilege(to_regrole('mam_powerbi_hr_reader'), relation.oid, 'DELETE')\n        or has_table_privilege(to_regrole('mam_powerbi_hr_reader'), relation.oid, 'TRUNCATE')\n        or has_table_privilege(to_regrole('mam_powerbi_hr_reader'), relation.oid, 'REFERENCES')\n        or has_table_privilege(to_regrole('mam_powerbi_hr_reader'), relation.oid, 'TRIGGER')\n      )\n  ) as no_other_business_relation_access,\n  not exists (\n    select 1\n    from pg_class relation\n    join pg_namespace schema on schema.oid = relation.relnamespace\n    where schema.nspname = 'extensions'\n      and relation.relname in ('pg_stat_statements', 'pg_stat_statements_info')\n      and (\n        has_table_privilege(to_regrole('mam_powerbi_hr_reader'), relation.oid, 'INSERT')\n        or has_table_privilege(to_regrole('mam_powerbi_hr_reader'), relation.oid, 'UPDATE')\n        or has_table_privilege(to_regrole('mam_powerbi_hr_reader'), relation.oid, 'DELETE')\n        or has_table_privilege(to_regrole('mam_powerbi_hr_reader'), relation.oid, 'TRUNCATE')\n        or has_table_privilege(to_regrole('mam_powerbi_hr_reader'), relation.oid, 'REFERENCES')\n        or has_table_privilege(to_regrole('mam_powerbi_hr_reader'), relation.oid, 'TRIGGER')\n      )\n  ) as shared_statistics_views_are_read_only,\n  not exists (\n    select 1\n    from pg_class sequence\n    join pg_namespace schema on schema.oid = sequence.relnamespace\n    where schema.nspname not in ('pg_catalog', 'information_schema')\n      and schema.nspname not like 'pg_temp_%'\n      and sequence.relkind = 'S'\n      and (\n        has_sequence_privilege(to_regrole('mam_powerbi_hr_reader'), sequence.oid, 'USAGE')\n        or has_sequence_privilege(to_regrole('mam_powerbi_hr_reader'), sequence.oid, 'SELECT')\n        or has_sequence_privilege(to_regrole('mam_powerbi_hr_reader'), sequence.oid, 'UPDATE')\n      )\n  ) as no_sequence_access,\n  not exists (\n    select 1\n    from pg_proc routine\n    join pg_namespace schema on schema.oid = routine.pronamespace\n    where has_schema_privilege(to_regrole('mam_powerbi_hr_reader'), schema.oid, 'USAGE')\n      and routine.prosecdef\n      and has_function_privilege(to_regrole('mam_powerbi_hr_reader'), routine.oid, 'EXECUTE')\n  ) as no_security_definer_routines,\n  not has_schema_privilege('service_role', 'powerbi_hr', 'USAGE')\n    and not has_table_privilege('service_role', 'powerbi_hr.employee_directory', 'SELECT')\n    and not has_schema_privilege('anon', 'powerbi_hr', 'USAGE')\n    and not has_table_privilege('anon', 'powerbi_hr.employee_directory', 'SELECT')\n    and not has_schema_privilege('authenticated', 'powerbi_hr', 'USAGE')\n    and not has_table_privilege('authenticated', 'powerbi_hr.employee_directory', 'SELECT') as app_roles_not_granted,\n  (\n    select array_agg(column_name::text order by ordinal_position)\n    from information_schema.columns\n    where table_schema = 'powerbi_hr'\n      and table_name = 'employee_directory'\n  ) = array[\n    'employee_id', 'first_name', 'last_name', 'full_name', 'company_key',\n    'position_title', 'is_active', 'started_date', 'created_at', 'updated_at',\n    'detail_updated_at', 'scheduled_employment_end_date', 'employment_type',\n    'working_weekdays', 'working_day_times', 'reason_for_leaving'\n  ]::text[] as projection_is_exact,\n  exists (\n    select 1 from pg_class relation\n    where relation.oid = to_regclass('powerbi_hr.employee_directory')\n      and relation.reloptions @> array['security_barrier=true']\n  ) as security_barrier,\n  exists (\n    select 1\n    from pg_db_role_setting settings\n    cross join lateral unnest(settings.setconfig) as config(value)\n    where settings.setrole = (\n      select oid from pg_roles where rolname = 'mam_powerbi_hr_reader'\n    )\n      and config.value = 'default_transaction_read_only=on'\n  ) as read_only_default,\n  exists (\n    select 1\n    from pg_db_role_setting settings\n    cross join lateral unnest(settings.setconfig) as config(value)\n    where settings.setrole = (\n      select oid from pg_roles where rolname = 'mam_powerbi_hr_reader'\n    )\n      and config.value = 'statement_timeout=60s'\n  ) as bounded_query_time"

# Keep the existing table checks. Column grants are independent ACL entries;
# SELECT remains permitted only on the projection and shared statistics views.
SCHEMA_SQL = """with effective_settings as (
  select distinct on (split_part(config.value, '=', 1))
    split_part(config.value, '=', 1) as name,
    split_part(config.value, '=', 2) as value
  from pg_db_role_setting settings
  cross join lateral unnest(settings.setconfig) as config(value)
  where settings.setrole in (0, to_regrole('mam_powerbi_hr_reader')::oid)
    and settings.setdatabase in (
      0, (select oid from pg_database where datname = current_database())
    )
    and split_part(config.value, '=', 1) in ('default_transaction_read_only', 'statement_timeout')
  -- Role+database overrides global role, which overrides database-wide settings.
  order by split_part(config.value, '=', 1),
    (settings.setrole <> 0) desc, (settings.setdatabase <> 0) desc
), column_access as (
  select relation.oid, schema.nspname, relation.relname,
    has_any_column_privilege(to_regrole('mam_powerbi_hr_reader'), relation.oid,
      'SELECT, INSERT, UPDATE, REFERENCES') as any_access,
    has_any_column_privilege(to_regrole('mam_powerbi_hr_reader'), relation.oid,
      'INSERT, UPDATE, REFERENCES') as write_access
  from pg_class relation
  join pg_namespace schema on schema.oid = relation.relnamespace
  where schema.nspname not in ('pg_catalog', 'information_schema')
    and schema.nspname not like 'pg_temp_%'
    and relation.relkind in ('r', 'p', 'v', 'm', 'f')
), table_checks as (""" + SCHEMA_SQL + """)
select
  table_checks.role_is_limited,
  table_checks.database_connect,
  table_checks.no_role_membership,
  table_checks.schema_usage,
  table_checks.schema_is_read_only,
  table_checks.view_select,
  table_checks.view_is_read_only
    and not has_any_column_privilege(to_regrole('mam_powerbi_hr_reader'),
      to_regclass('powerbi_hr.employee_directory'), 'INSERT, UPDATE, REFERENCES') as view_is_read_only,
  table_checks.source_tables_are_private
    and not has_any_column_privilege(to_regrole('mam_powerbi_hr_reader'),
      to_regclass('public.internal_org_people'), 'SELECT, INSERT, UPDATE, REFERENCES')
    and not has_any_column_privilege(to_regrole('mam_powerbi_hr_reader'),
      to_regclass('private.employee_directory_details'), 'SELECT, INSERT, UPDATE, REFERENCES') as source_tables_are_private,
  table_checks.no_other_business_relation_access and not exists (
    select 1 from column_access
    where oid <> to_regclass('powerbi_hr.employee_directory')
      and not (nspname = 'extensions' and relname in ('pg_stat_statements', 'pg_stat_statements_info'))
      and any_access
  ) as no_other_business_relation_access,
  table_checks.shared_statistics_views_are_read_only and not exists (
    select 1 from column_access
    where nspname = 'extensions' and relname in ('pg_stat_statements', 'pg_stat_statements_info')
      and write_access
  ) as shared_statistics_views_are_read_only,
  table_checks.no_sequence_access,
  table_checks.no_security_definer_routines,
  table_checks.app_roles_not_granted and not exists (
    select 1 from unnest(array['anon', 'authenticated', 'service_role']) as app_role(name)
    where has_any_column_privilege(to_regrole(app_role.name),
      to_regclass('powerbi_hr.employee_directory'), 'SELECT, INSERT, UPDATE, REFERENCES')
  ) as app_roles_not_granted,
  table_checks.projection_is_exact,
  table_checks.security_barrier,
  coalesce((select value = 'on' from effective_settings where name = 'default_transaction_read_only'), false) as read_only_default,
  coalesce((select value = '60s' from effective_settings where name = 'statement_timeout'), false) as bounded_query_time
from table_checks
"""

AUDIT_SQL = """begin read only;
set local statement_timeout = '15s';
set local lock_timeout = '3s';
select json_build_object(
  'schema', (select row_to_json(checks) from (""" + SCHEMA_SQL + """) checks),
  'ledger', (select coalesce(json_agg(json_build_object(
    'version', version, 'name', name, 'statements', statements)), '[]'::json)
    from supabase_migrations.schema_migrations where version = '20260924235000')
) as audit;
rollback;
"""


def api(path, body=None):
    request = urllib.request.Request(
        "https://api.supabase.com/v1/projects/" + PROJECT + path,
        headers={"Authorization": "Bearer " + os.environ["SUPABASE_ACCESS_TOKEN"],
                 "Content-Type": "application/json"},
        data=None if body is None else json.dumps(body).encode(),
        method="GET" if body is None else "POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Supabase Management API HTTP {error.code}") from None
    except (urllib.error.URLError, TimeoutError):
        raise RuntimeError("Supabase Management API transport failed") from None


def inspect():
    project = api("")
    if project.get("id") != PROJECT or project.get("organization_id") != ORGANISATION:
        raise RuntimeError("MAM Supabase target mismatch")
    rows = api("/database/query", {"query": AUDIT_SQL})
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0].get("audit"), dict):
        raise RuntimeError("Unexpected metadata response")
    audit = rows[0]["audit"]
    schema = audit.get("schema")
    ledger = audit.get("ledger")
    if not isinstance(schema, dict) or set(schema) != SCHEMA_KEYS or not isinstance(ledger, list):
        raise RuntimeError("Incomplete metadata response")
    if any(value is not None and not isinstance(value, bool) for value in schema.values()):
        raise RuntimeError("Unexpected schema predicate")
    sources = ledger[0].get("statements") if len(ledger) == 1 else None
    exact_source = (isinstance(sources, list) and len(sources) == 1
                    and isinstance(sources[0], str)
                    and hashlib.sha256(sources[0].encode()).hexdigest() == EXPECTED_SOURCE_SHA256)
    result = {
        "project": PROJECT, "organisation": ORGANISATION, "version": VERSION,
        "migrationRecorded": len(ledger) == 1,
        "historicalSourceMatches": exact_source,
        "schema": {key: value is True for key, value in schema.items()},
    }
    result["contractSatisfied"] = (result["migrationRecorded"] and exact_source
                                   and all(result["schema"].values()))
    return result


def main():
    if sys.argv[1:] != ["inspect"]:
        print("Usage: inspect-powerbi-hr-directory.py inspect", file=sys.stderr)
        return 2
    try:
        result = inspect()
    except (RuntimeError, KeyError, ValueError, TypeError):
        print("Power BI metadata inspection failed; verify the approved MAM target and reader route.", file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2))
    return 0 if result["contractSatisfied"] else 1


if __name__ == "__main__":
    sys.exit(main())
