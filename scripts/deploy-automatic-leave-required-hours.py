"""Apply and verify automatic conditional-leave hours in MAM production."""
import hashlib
import json
from pathlib import Path
import re
import runpy
import sys

base = runpy.run_path(str(Path(__file__).with_name("deploy-reliability-migrations.py")))
query, api, literal = base["query"], base["api"], base["literal"]
version = "20260922180000"
name = "automatic_leave_balance_required_hours"
sql = (base["ROOT"] / "supabase/migrations" / f"{version}_{name}.sql").read_text()


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def inspect():
    row = query("""
      select
        exists(select 1 from supabase_migrations.schema_migrations where version='20260922180000') migration_recorded,
        (select is_nullable='NO' from information_schema.columns
          where table_schema='private' and table_name='leave_balance_approvals' and column_name='required_hours') hours_required,
        not exists(select 1 from private.leave_balance_approvals where required_hours is null) no_missing_hours,
        exists(select 1 from pg_trigger where tgrelid='private.leave_balance_approvals'::regclass
          and tgname='leave_balance_approvals_fill_required_hours' and tgenabled='O'
          and not tgisinternal and tgtype=7
          and tgfoid=to_regprocedure('private.fill_leave_balance_required_hours()')) insert_guard_enabled,
        not has_function_privilege('authenticated',to_regprocedure('private.leave_request_required_hours(uuid)'),'EXECUTE')
          and not has_function_privilege('anon',to_regprocedure('private.leave_request_required_hours(uuid)'),'EXECUTE')
          and not has_function_privilege('service_role',to_regprocedure('private.leave_request_required_hours(uuid)'),'EXECUTE') helper_private,
        not has_function_privilege('authenticated',to_regprocedure('private.fill_leave_balance_required_hours()'),'EXECUTE')
          and not has_function_privilege('anon',to_regprocedure('private.fill_leave_balance_required_hours()'),'EXECUTE')
          and not has_function_privilege('service_role',to_regprocedure('private.fill_leave_balance_required_hours()'),'EXECUTE') insert_guard_private,
        has_function_privilege('authenticated','public.decide_leave_with_balance(uuid,text,text)','EXECUTE')
          and not has_function_privilege('anon','public.decide_leave_with_balance(uuid,text,text)','EXECUTE') reviewer_access
    """)[0]
    expected = dict(re.findall(
        r"create (?:or replace )?function ([\w.]+)\([^;]+?as \$\$(.*?)\$\$;",
        sql, re.S | re.I,
    ))
    require(len(expected) == 5, "Unexpected reviewed function definitions")
    definitions = query("""
      select n.nspname || '.' || p.proname name, p.prosrc body
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where p.oid in (
        to_regprocedure('private.leave_request_required_hours(uuid)'),
        to_regprocedure('public.decide_leave_with_balance(uuid,text,text)'),
        to_regprocedure('public.set_leave_balance_required_hours(uuid,numeric)'),
        to_regprocedure('private.leave_payroll_balance_sufficient(uuid)'),
        to_regprocedure('private.fill_leave_balance_required_hours()')
      )
    """)
    row["definitions_match"] = len(definitions) == len(expected) and all(
        item["body"] == expected[item["name"]] for item in definitions
    )
    print(json.dumps(row))
    return row


project = api("")
require(project.get("id") == base["PROJECT"] and project.get("organization_id") == base["ORG"], "Wrong MAM target")
operation = sys.argv[1] if len(sys.argv) > 1 else ""
require(operation in ("inspect", "apply"), "Use inspect or apply <reviewed-sha256>")

if operation == "apply":
    require(len(sys.argv) == 3 and hashlib.sha256(sql.encode()).hexdigest() == sys.argv[2], "Reviewed migration differs")
    require(query("select version from supabase_migrations.schema_migrations where version='20260922170000'"), "Expected predecessor migration missing")
    existing = query("select statements from supabase_migrations.schema_migrations where version=" + literal(version))
    if existing:
        require(existing[0]["statements"] == [sql], "Recorded migration differs")
    else:
        require(sql.count("\ncommit;") == 1, "Unexpected migration transaction")
        history = "insert into supabase_migrations.schema_migrations(version,name,statements) values(" + literal(version) + "," + literal(name) + ",ARRAY[" + literal(sql) + "]);"
        release = sql.replace("begin;", "begin;\nset local lock_timeout='5s';\nset local statement_timeout='75s';", 1).replace("\ncommit;", "\n" + history + "\nnotify pgrst,'reload schema';\ncommit;")
        query(release)

result = inspect()
if operation == "apply":
    require(all(result.values()), "Automatic-hours migration read-back failed")
