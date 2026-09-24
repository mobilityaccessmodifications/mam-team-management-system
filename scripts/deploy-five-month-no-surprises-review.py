"""Target-checked deployment for the 5-Month No-Surprises Review."""

import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request


PROJECT = "xtwlrjqbusadghavchqm"
ORGANISATION = "fwlmbmospuwoaosffvmw"
VERSION = "20260924200000"
NAME = "five_month_no_surprises_review"
ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / f"{VERSION}_{NAME}.sql"
PREDECESSOR_VERSION = "20260923230000"
PREDECESSOR = ROOT / "supabase" / "migrations" / f"{PREDECESSOR_VERSION}_check_in_review_outcomes.sql"


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
        detail = error.read().decode(errors="replace")
        raise SystemExit(f"Supabase API request failed ({error.code}): {detail}") from error


def query(sql):
    return api("/database/query", {"query": sql})


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def verify_schema(expected_activation=None):
    state = query("""
      select
        (select count(*) = 1
         from private.people_hub_release_flags release
         where release.feature = 'five_month_no_surprises_review') as release_gate_row,
        (select release.enabled
         from private.people_hub_release_flags release
         where release.feature = 'five_month_no_surprises_review') as release_enabled,
        (select count(*) = 1
         from private.employee_check_in_schedule(date '2026-09-14') schedule
         where schedule.milestone = '5_month'
           and schedule.reminder_sequence = 'initial'
           and schedule.due_date = date '2027-02-11'
           and schedule.notify_date = date '2027-02-04') as five_month_schedule,
        not exists (
          select 1
          from private.employee_check_in_schedule(date '2026-09-14') schedule
          where schedule.milestone = '5_month'
            and schedule.reminder_sequence <> 'initial'
        ) as no_duplicate_reminder,
        (select relrowsecurity and relforcerowsecurity
         from pg_class
         where oid = 'private.people_hub_release_flags'::regclass) as release_gate_rls,
        not has_table_privilege(
          'authenticated',
          'private.people_hub_release_flags',
          'SELECT'
        ) as browser_release_gate_denied,
        not has_table_privilege(
          'service_role',
          'private.people_hub_release_flags',
          'SELECT'
        ) as service_release_gate_denied,
        to_regprocedure(
          'private.activate_five_month_no_surprises_review()'
        ) is not null as activation_function_present,
        not has_function_privilege(
          'authenticated',
          'private.activate_five_month_no_surprises_review()',
          'EXECUTE'
        ) as browser_activation_denied,
        not has_function_privilege(
          'service_role',
          'private.activate_five_month_no_surprises_review()',
          'EXECUTE'
        ) as service_activation_denied,
        to_regprocedure(
          'private.employee_five_month_group_already_satisfied(uuid,date)'
        ) is not null as legacy_satisfaction_predicate_present,
        exists (
          select 1
          from pg_trigger trigger
          where trigger.tgrelid = 'private.employee_check_in_reminders'::regclass
            and trigger.tgname = 'employee_check_in_reminders_prevent_legacy_five_month_reactivation'
            and not trigger.tgisinternal
            and trigger.tgenabled <> 'D'
        ) as legacy_reactivation_guard_present,
        position(
          'people_hub_release_flags'
          in pg_get_functiondef(
            'public.claim_due_employee_check_in_reminders(integer)'::regprocedure
          )
        ) > 0 as claim_release_gate_present,
        position(
          'people_hub_release_flags'
          in pg_get_functiondef(
            'public.prepare_employee_check_in_reminder_delivery(uuid,uuid)'::regprocedure
          )
        ) > 0 as prepare_release_gate_present,
        (select relrowsecurity and relforcerowsecurity
         from pg_class
         where oid = 'private.employee_check_in_review_notifications'::regclass) as outbox_rls,
        not has_table_privilege(
          'authenticated',
          'private.employee_check_in_review_notifications',
          'SELECT'
        ) as browser_outbox_denied,
        not has_table_privilege(
          'service_role',
          'private.employee_check_in_review_notifications',
          'SELECT'
        ) as service_outbox_denied,
        has_function_privilege(
          'service_role',
          'public.claim_due_employee_check_in_review_notifications(integer)',
          'EXECUTE'
        ) as worker_claim_granted,
        not has_function_privilege(
          'authenticated',
          'public.claim_due_employee_check_in_review_notifications(integer)',
          'EXECUTE'
        ) as browser_claim_denied,
        position(
          'employee_check_in_review_notifications'
          in pg_get_functiondef(
            'public.record_employee_check_in_review(uuid,text,date,text,bigint)'::regprocedure
          )
        ) > 0 as review_enqueue_present,
        position(
          '''5_month'''
          in pg_get_functiondef(
            'public.prepare_employee_check_in_reminder_delivery(uuid,uuid)'::regprocedure
          )
        ) > 0 as five_month_employee_delivery,
        position(
          'personal_email'
          in pg_get_triggerdef(
            (select oid from pg_trigger
             where tgname = 'employee_directory_details_sync_employee_check_in_manager_email'
               and not tgisinternal)
          )
        ) > 0 as personal_email_recovery_trigger,
        private.notification_event_key_valid(
          'checkin:00000000-0000-4000-8000-000000000001:5-month:initial:live'
        ) as reminder_receipt_key,
        private.notification_event_key_valid(
          'checkin-review:00000000-0000-4000-8000-000000000001:hr:1:live'
        ) as review_receipt_key,
        not private.notification_event_key_valid(
          'checkin:00000000-0000-4000-8000-000000000001:5-month:final:live'
        ) as final_receipt_rejected
    """)[0]
    release_enabled = bool(state.pop("release_enabled"))
    schedule_visible = bool(state.pop("five_month_schedule"))
    require(all(state.values()), "Deployed 5-Month review schema verification failed")
    require(
        schedule_visible == release_enabled,
        "The 5-Month schedule visibility does not match its release gate",
    )
    if expected_activation is not None:
        require(
            release_enabled == expected_activation,
            "The 5-Month release gate is in the wrong state",
        )
    operational = query("""
      select
        (select count(*)
         from private.employee_check_in_reminders reminder
         where reminder.milestone = '5_month'
           and reminder.reminder_sequence = 'final'
           and reminder.delivery_status not in ('superseded', 'cancelled')) as active_legacy_final_reminders,
        (select count(*)
         from private.employee_check_in_reminders reminder
         where reminder.milestone = '5_month'
           and reminder.delivery_status = 'claimed') as claimed_five_month_reminders,
        (select count(*)
         from private.employee_check_in_reminders reminder
         where reminder.milestone = '5_month'
           and reminder.reminder_sequence = 'initial'
           and reminder.delivery_status = 'scheduled') as dispatchable_five_month_reminders,
        (select count(*)
         from private.employee_check_in_reminders reminder
         where reminder.milestone = '5_month'
           and reminder.delivery_status in ('scheduled', 'claimed', 'needs_review'))
          as paused_five_month_reminders,
        (select count(*)
         from public.internal_org_people person
         cross join lateral private.employee_check_in_schedule(person.started_date) schedule
         where person.node_kind = 'person'
           and person.is_active
           and person.started_date is not null
           and schedule.milestone = '5_month'
           and not exists (
             select 1
             from private.employee_check_in_reminders reminder
             where reminder.person_id = person.id
               and reminder.milestone = schedule.milestone
               and reminder.reminder_sequence = 'initial'
               and reminder.due_date = schedule.due_date
               and reminder.delivery_status not in ('superseded', 'cancelled')
           )
           and not private.employee_five_month_group_already_satisfied(
             person.id,
             schedule.due_date
           )) as missing_active_five_month_rows,
        (select count(*)
         from private.employee_check_in_reminders reminder
         where reminder.milestone = '5_month'
           and reminder.reminder_sequence = 'initial'
           and reminder.delivery_status in ('scheduled', 'claimed', 'needs_review')
           and private.employee_five_month_group_already_satisfied(
             reminder.person_id,
             reminder.due_date
           )) as reactivated_legacy_satisfied_groups
    """)[0]
    require(
        operational["active_legacy_final_reminders"] == 0,
        "Active legacy 5-Month final reminders remain after cutover",
    )
    require(
        operational["reactivated_legacy_satisfied_groups"] == 0,
        "A legacy-satisfied 5-Month group was reactivated",
    )
    if not release_enabled:
        require(
            operational["paused_five_month_reminders"] == 0,
            "The disabled 5-Month release has dispatchable work",
        )
    else:
        require(
            operational["missing_active_five_month_rows"] == 0,
            "The 5-Month schedule is not active for every current employee",
        )
    print(json.dumps({
        "releaseEnabled": release_enabled,
        "scheduleVisible": schedule_visible,
        "schema": state,
        "operational": operational,
    }))


operation = sys.argv[1] if len(sys.argv) > 1 else ""
require(
    operation in ("inspect", "apply", "activate", "advisors"),
    "Use inspect, advisors, apply <reviewed-sha256> or activate <reviewed-sha256>",
)
project = api("")
require(
    project["id"] == PROJECT and project["organization_id"] == ORGANISATION,
    "MAM Supabase target mismatch",
)
print(json.dumps({"verifiedProject": PROJECT, "verifiedOrganisation": ORGANISATION}))

if operation == "advisors":
    for category in ("security", "performance"):
        data = api("/advisors/" + category)
        counts = {}
        for lint in data.get("lints", []):
            key = lint.get("name", "unknown") + ":" + lint.get("level", "unknown")
            counts[key] = counts.get(key, 0) + 1
        print(json.dumps({"category": category, "counts": counts}))
    sys.exit(0)

migration_sql = MIGRATION.read_text()
predecessor_sql = PREDECESSOR.read_text()
if operation in ("apply", "activate"):
    require(
        len(sys.argv) == 3
        and hashlib.sha256(migration_sql.encode()).hexdigest() == sys.argv[2],
        "Reviewed migration differs",
    )

history = query(
    "select version, statements from supabase_migrations.schema_migrations "
    f"where version in ({literal(PREDECESSOR_VERSION)},{literal(VERSION)}) "
    "order by version"
)
by_version = {row["version"]: row["statements"] for row in history}
require(PREDECESSOR_VERSION in by_version, "Check-In review outcome predecessor is missing")
require(
    by_version[PREDECESSOR_VERSION] == [predecessor_sql],
    "Recorded Check-In review outcome predecessor differs from source",
)

prerequisites = query("""
  select
    to_regclass('private.employee_check_in_reminders') is not null as reminders,
    to_regclass('private.employee_check_in_reviews') is not null as reviews,
    to_regprocedure('private.employee_check_in_schedule(date)') is not null as schedule,
    to_regprocedure('private.sync_employee_check_in_reminders(uuid,boolean,boolean)') is not null as sync,
    to_regprocedure('private.resolve_internal_org_employee_manager(uuid)') is not null as manager_resolution,
    to_regprocedure('private.notification_event_key_valid(text)') is not null as receipt_validator,
    to_regprocedure('public.record_employee_check_in_review(uuid,text,date,text,bigint)') is not null as review_write
""")[0]
require(all(prerequisites.values()), "5-Month review deployment prerequisites are missing")

existing = by_version.get(VERSION)
applied_now = operation == "apply" and existing is None
if existing is not None:
    require(existing == [migration_sql], "Recorded 5-Month migration differs from source")
print(json.dumps({
    "migrationRecorded": existing is not None,
    "prerequisites": prerequisites,
    "reviewedSha256": hashlib.sha256(migration_sql.encode()).hexdigest(),
}))

if operation == "apply" and existing is None:
    require(migration_sql.count("\ncommit;") == 1, "Unexpected migration transaction structure")
    ledger = (
        "insert into supabase_migrations.schema_migrations(version,name,statements) values("
        + literal(VERSION)
        + ","
        + literal(NAME)
        + ",ARRAY["
        + literal(migration_sql)
        + "]);"
    )
    release = migration_sql.replace(
        "begin;",
        "begin;\nset local lock_timeout='5s';\nset local statement_timeout='120s';",
        1,
    ).replace(
        "\ncommit;",
        "\n" + ledger + "\nnotify pgrst,'reload schema';\ncommit;",
    )
    query(release)

if operation == "activate":
    require(existing is not None, "Apply the reviewed 5-Month migration before activation")
    query("""
      begin;
      set local lock_timeout='5s';
      set local statement_timeout='120s';
      select private.activate_five_month_no_surprises_review();
      commit;
    """)
    verify_schema(expected_activation=True)
elif existing is not None or operation == "apply":
    verify_schema(expected_activation=False if applied_now else None)
