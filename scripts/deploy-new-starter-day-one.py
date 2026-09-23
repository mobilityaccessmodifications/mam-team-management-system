"""Apply and verify the reviewed Day 1 new-starter reminder migration."""

import hashlib
import json
from pathlib import Path
import runpy
import sys


base = runpy.run_path(str(Path(__file__).with_name("deploy-reliability-migrations.py")))
query, api, literal = base["query"], base["api"], base["literal"]
version = "20260923120000"
name = "new_starter_day_one_reminders"
sql = (base["ROOT"] / "supabase/migrations" / f"{version}_{name}.sql").read_text()


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def inspect():
    recorded = query(
        "select statements from supabase_migrations.schema_migrations where version="
        + literal(version)
    )
    present = query("""
      select to_regclass('private.employee_new_starter_day_one_reminders') is not null as reminders_present,
        to_regclass('private.employee_new_starter_day_one_events') is not null as events_present
    """)[0]
    if not all(present.values()):
        row = {
            **present,
            "reminders_rls_forced": False,
            "events_rls_forced": False,
            "sync_triggers_enabled": False,
            "delivery_keys_valid": False,
            "service_role_workers": False,
            "workers_private": False,
            "reminder_count": None,
            "scheduled_count": None,
            "review_count": None,
            "migration_recorded": recorded == [{"statements": [sql]}],
        }
        print(json.dumps(row, sort_keys=True))
        return row
    row = query("""
      select
        (select relrowsecurity and relforcerowsecurity from pg_class
          where oid='private.employee_new_starter_day_one_reminders'::regclass) as reminders_rls_forced,
        (select relrowsecurity and relforcerowsecurity from pg_class
          where oid='private.employee_new_starter_day_one_events'::regclass) as events_rls_forced,
        (select count(*)=2 from pg_trigger where not tgisinternal and tgenabled='O'
          and tgname in ('sync_new_starter_after_person_change','sync_new_starter_after_detail_change')) as sync_triggers_enabled,
        private.notification_event_key_valid(
          'new-starter:10000000-0000-4000-8000-000000000001:day-one:test'
        ) and private.notification_event_key_valid(
          'new-starter:10000000-0000-4000-8000-000000000001:day-one:live'
        ) as delivery_keys_valid,
        has_function_privilege('service_role','public.claim_due_new_starter_day_one_reminders(integer)','EXECUTE')
          and has_function_privilege('service_role','public.prepare_new_starter_day_one_delivery(uuid,uuid)','EXECUTE')
          and has_function_privilege('service_role','public.complete_new_starter_day_one_delivery(uuid,uuid)','EXECUTE')
          and has_function_privilege('service_role','public.fail_new_starter_day_one_delivery(uuid,uuid,text)','EXECUTE')
          as service_role_workers,
        not has_function_privilege('authenticated','public.claim_due_new_starter_day_one_reminders(integer)','EXECUTE')
          and not has_function_privilege('anon','public.claim_due_new_starter_day_one_reminders(integer)','EXECUTE')
          and not has_function_privilege('authenticated','public.prepare_new_starter_day_one_delivery(uuid,uuid)','EXECUTE')
          and not has_function_privilege('anon','public.prepare_new_starter_day_one_delivery(uuid,uuid)','EXECUTE')
          as workers_private,
        (select count(*) from private.employee_new_starter_day_one_reminders) as reminder_count,
        (select count(*) from private.employee_new_starter_day_one_reminders where status='scheduled') as scheduled_count,
        (select count(*) from private.employee_new_starter_day_one_reminders where status='needs_review') as review_count
    """)[0]
    row.update(present)
    row["migration_recorded"] = recorded == [{"statements": [sql]}]
    print(json.dumps(row, sort_keys=True))
    return row


project = api("")
require(
    project.get("id") == base["PROJECT"] and project.get("organization_id") == base["ORG"],
    "Wrong MAM target",
)
operation = sys.argv[1] if len(sys.argv) > 1 else ""
require(operation in ("inspect", "apply"), "Use inspect or apply <reviewed-sha256>")

if operation == "apply":
    require(
        len(sys.argv) == 3 and hashlib.sha256(sql.encode()).hexdigest() == sys.argv[2],
        "Reviewed migration differs",
    )
    require(
        query("select version from supabase_migrations.schema_migrations where version='20260923010000'"),
        "Expected durable-notification predecessor is missing",
    )
    existing = query(
        "select statements from supabase_migrations.schema_migrations where version=" + literal(version)
    )
    if existing:
        require(existing == [{"statements": [sql]}], "Recorded migration differs")
    else:
        require(
            sql.startswith("begin;\n") and sql.count("\ncommit;") == 1 and sql.rstrip().endswith("commit;"),
            "Unexpected migration transaction",
        )
        history = (
            "insert into supabase_migrations.schema_migrations(version,name,statements) values("
            + literal(version) + "," + literal(name) + ",ARRAY[" + literal(sql) + "]);"
        )
        release = sql.replace(
            "begin;", "begin;\nset local lock_timeout='5s';\nset local statement_timeout='75s';", 1
        ).replace("\ncommit;", "\n" + history + "\nnotify pgrst,'reload schema';\ncommit;")
        query(release)

result = inspect()
required = (
    "reminders_present", "events_present", "reminders_rls_forced", "events_rls_forced",
    "sync_triggers_enabled", "delivery_keys_valid", "service_role_workers", "workers_private",
    "migration_recorded",
)
require(all(result[key] is True for key in required), "Day 1 reminder migration read-back failed")
