import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request


PROJECT = "xtwlrjqbusadghavchqm"
ORGANISATION = "fwlmbmospuwoaosffvmw"
VERSION = "20260925010000"
NAME = "six_month_casual_check_in"
ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / f"{VERSION}_{NAME}.sql"
PREDECESSORS = {
    "20260924200000": ROOT / "supabase/migrations/20260924200000_five_month_no_surprises_review.sql",
    "20260924230000": ROOT / "supabase/migrations/20260924230000_six_month_check_in_review.sql",
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
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise SystemExit(f"Supabase API request failed ({error.code})") from error


def query(sql):
    return api("/database/query", {"query": sql})


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def verify_schema(expected_enabled=None):
    state = query("""
      select
        (select count(*) = 1
         from private.people_hub_release_flags release
         where release.feature = 'six_month_casual_check_in') as release_gate_row,
        (select release.enabled
         from private.people_hub_release_flags release
         where release.feature = 'six_month_casual_check_in') as release_enabled,
        (select count(*) = 1
         from private.employee_check_in_schedule(date '2026-03-15') schedule
         where schedule.milestone = '6_month_casual'
           and schedule.reminder_sequence = 'initial'
           and schedule.due_date = date '2026-09-15'
           and schedule.notify_date = date '2026-09-08') as casual_schedule,
        (select relrowsecurity and relforcerowsecurity
         from pg_class
         where oid = 'private.people_hub_release_flags'::regclass) as release_gate_rls,
        not has_table_privilege('authenticated', 'private.people_hub_release_flags', 'SELECT')
          as browser_release_gate_denied,
        not has_table_privilege('service_role', 'private.people_hub_release_flags', 'SELECT')
          as service_release_gate_denied,
        not has_function_privilege('authenticated', 'private.activate_six_month_casual_check_in()', 'EXECUTE')
          as browser_activation_denied,
        not has_function_privilege('service_role', 'private.activate_six_month_casual_check_in()', 'EXECUTE')
          as service_activation_denied,
        position('6_month_casual' in pg_get_functiondef(
          'private.sync_employee_check_in_reminders(uuid,boolean,boolean)'::regprocedure
        )) > 0 as sync_supports_casual,
        position('six_month_casual_check_in' in pg_get_functiondef(
          'public.claim_due_employee_check_in_reminders(integer)'::regprocedure
        )) > 0 as claim_gate_present,
        position('six_month_casual_check_in' in pg_get_functiondef(
          'public.prepare_employee_check_in_reminder_delivery(uuid,uuid)'::regprocedure
        )) > 0 as delivery_gate_present,
        position('6_month_casual' in pg_get_functiondef(
          'public.prepare_employee_check_in_reminder_delivery(uuid,uuid)'::regprocedure
        )) > 0 as casual_email_allowlist_present,
        position('6_month_casual' in pg_get_functiondef(
          'public.prepare_employee_check_in_review_notification_delivery(uuid,uuid)'::regprocedure
        )) > 0 as casual_hr_review_allowlist_present,
        exists (
          select 1 from pg_trigger trigger
          where trigger.tgrelid = 'private.employee_directory_details'::regclass
            and trigger.tgname = 'employee_directory_details_sync_check_in_employment_type'
            and not trigger.tgisinternal
        ) as employment_type_trigger_present
    """)[0]
    enabled = bool(state.pop("release_enabled"))
    schedule_visible = bool(state.pop("casual_schedule"))
    require(all(state.values()), "Deployed Casual Check-In schema verification failed")
    require(schedule_visible == enabled, "The Casual Check-In schedule does not match its release gate")
    if expected_enabled is not None:
        require(enabled == expected_enabled, "The Casual Check-In release gate is in the wrong state")

    operational = query("""
      select
        (select count(*)
         from public.internal_org_people person
         join private.employee_directory_details detail on detail.person_id = person.id
         where person.node_kind = 'person'
           and person.is_active
           and person.started_date is not null
           and detail.employment_type = 'casual') as eligible_active_casual_people,
        (select count(*)
         from private.employee_check_in_reminders reminder
         where reminder.milestone = '6_month_casual'
           and reminder.delivery_status = 'scheduled'
           and reminder.notify_date < (clock_timestamp() at time zone 'Australia/Melbourne')::date)
          as overdue_scheduled_reminders,
        (select count(*)
         from private.employee_check_in_reminders reminder
         where reminder.milestone = '6_month_casual'
           and reminder.delivery_status = 'needs_review'
           and reminder.needs_review_reason = 'historic_cutover') as historical_rows_held_for_review,
        (select count(*)
         from public.internal_org_people person
         join private.employee_directory_details detail on detail.person_id = person.id
         cross join lateral private.employee_check_in_schedule(person.started_date) schedule
         where person.node_kind = 'person'
           and person.is_active
           and person.started_date is not null
           and detail.employment_type = 'casual'
           and schedule.milestone = '6_month_casual'
           and not exists (
             select 1 from private.employee_check_in_reminders reminder
             where reminder.person_id = person.id
               and reminder.milestone = schedule.milestone
               and reminder.reminder_sequence = schedule.reminder_sequence
               and reminder.due_date = schedule.due_date
               and reminder.delivery_status not in ('superseded', 'cancelled')
           )) as missing_eligible_rows,
        (select count(*)
         from private.employee_check_in_reminders reminder
         where reminder.milestone = '6_month_casual'
           and reminder.delivery_status in ('scheduled', 'claimed', 'needs_review')
           and not exists (
             select 1
             from private.employee_directory_details detail
             join public.internal_org_people person on person.id = detail.person_id
             where person.id = reminder.person_id
               and person.node_kind = 'person'
               and person.is_active
               and person.started_date is not null
               and detail.employment_type = 'casual'
           )) as ineligible_open_rows,
        (select count(*)
         from private.employee_check_in_reminders reminder
         where reminder.milestone = '6_month_casual'
           and reminder.delivery_status in ('scheduled', 'claimed', 'needs_review')) as open_reminders
    """)[0]
    if enabled:
        require(operational["overdue_scheduled_reminders"] == 0,
                "Overdue Casual reminders could be sent automatically")
        require(operational["missing_eligible_rows"] == 0,
                "Some active Casual employees are missing their six-month reminder")
        require(operational["ineligible_open_rows"] == 0,
                "An ineligible employee has an open Casual reminder")
    else:
        require(operational["open_reminders"] == 0,
                "A disabled Casual schedule unexpectedly has open reminder rows")
    print(json.dumps({
        "releaseEnabled": enabled,
        "scheduleVisible": schedule_visible,
        "schema": state,
        "operational": operational,
    }))


operation = sys.argv[1] if len(sys.argv) > 1 else ""
require(operation in ("inspect", "apply", "activate"),
        "Use inspect, apply <reviewed-sha256> or activate <reviewed-sha256>")
project = api("")
require(project["id"] == PROJECT and project["organization_id"] == ORGANISATION,
        "MAM Supabase target mismatch")
print(json.dumps({"verifiedProject": PROJECT, "verifiedOrganisation": ORGANISATION}))

migration_sql = MIGRATION.read_text()
if operation in ("apply", "activate"):
    require(len(sys.argv) == 3
            and hashlib.sha256(migration_sql.encode()).hexdigest() == sys.argv[2],
            "Reviewed migration differs")

versions = ",".join(literal(version) for version in (*PREDECESSORS.keys(), VERSION))
history = query(
    "select version, statements from supabase_migrations.schema_migrations "
    f"where version in ({versions}) order by version"
)
by_version = {row["version"]: row["statements"] for row in history}
for version, predecessor in PREDECESSORS.items():
    require(version in by_version, f"Required Check-In predecessor {version} is missing")
    require(by_version[version] == [predecessor.read_text()],
            f"Recorded Check-In predecessor {version} differs from source")

existing = by_version.get(VERSION)
applied_now = operation == "apply" and existing is None
if existing is not None:
    require(existing == [migration_sql], "Recorded Casual Check-In migration differs from source")

print(json.dumps({
    "migrationRecorded": existing is not None,
    "reviewedSha256": hashlib.sha256(migration_sql.encode()).hexdigest(),
}))

if operation == "apply" and existing is None:
    require(migration_sql.count("\ncommit;") == 1, "Unexpected migration transaction structure")
    ledger = (
        "insert into supabase_migrations.schema_migrations(version,name,statements) values("
        + literal(VERSION) + "," + literal(NAME) + ",ARRAY[" + literal(migration_sql) + "]);"
    )
    release = migration_sql.replace(
        "begin;", "begin;\nset local lock_timeout='5s';\nset local statement_timeout='120s';", 1
    ).replace("\ncommit;", "\n" + ledger + "\nnotify pgrst,'reload schema';\ncommit;")
    query(release)

if operation == "activate":
    require(existing is not None, "Apply the reviewed Casual Check-In migration before activation")
    query("""
      begin;
      set local lock_timeout='5s';
      set local statement_timeout='120s';
      select private.activate_six_month_casual_check_in();
      commit;
    """)
    verify_schema(expected_enabled=True)
elif existing is not None or operation == "apply":
    verify_schema(expected_enabled=False if applied_now else None)
