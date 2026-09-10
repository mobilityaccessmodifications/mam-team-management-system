"""Apply the reviewed email snapshot migration to the verified MAM project.

Use the MAM credential helper. Deploy the reviewed GitHub app and n8n receiver
first; then use `apply <sha256>`. `inspect` verifies metadata without staff data.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.request

REF = 'xtwlrjqbusadghavchqm'
ORG = 'fwlmbmospuwoaosffvmw'
ROOT = Path(__file__).resolve().parents[1]
VERSION = '20260911010000'
NAME = 'leave_email_balance_snapshot'
FILE = ROOT / 'supabase/migrations' / (VERSION + '_' + NAME + '.sql')


def api(path, body=None):
    request = urllib.request.Request('https://api.supabase.com/v1/projects/' + REF + path,
        headers={'Authorization': 'Bearer ' + os.environ['SUPABASE_ACCESS_TOKEN'],
                 'Content-Type': 'application/json', 'User-Agent': 'supabase-cli/2.54.11'},
        data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.load(response)


def query(sql):
    return api('/database/query', {'query': sql})


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def require(condition, message):
    if not condition:
        raise SystemExit(message)


project = api('')
require(project['id'] == REF and project['organization_id'] == ORG, 'MAM project target mismatch')
print('Verified MAM project', REF)
sql = FILE.read_text()
existing = query('select version from supabase_migrations.schema_migrations where version=' + literal(VERSION))
if sys.argv[1] == 'apply':
    require(hashlib.sha256(sql.encode()).hexdigest() == sys.argv[2], 'Reviewed migration differs')
    if existing:
        print('Migration already recorded; checking deployed definitions')
    else:
        # Refuse to overwrite an independently changed enqueue function.
        baseline = (ROOT / 'supabase/migrations/20260908015416_security_notification_outbox_and_grant_audit.sql').read_text()
        old_body = baseline.split('create function private.enqueue_leave_notification', 1)[1].split('as $$', 1)[1].split('$$;', 1)[0]
        current = query("select prosrc from pg_proc where oid='private.enqueue_leave_notification(uuid,text,boolean)'::regprocedure")
        require(current[0]['prosrc'] == old_body, 'Existing enqueue definition differs from baseline')
        require(sql.count('\ncommit;') == 1, 'Unexpected migration transaction structure')
        history = 'insert into supabase_migrations.schema_migrations(version,name,statements) values(' + literal(VERSION) + ',' + literal(NAME) + ',ARRAY[' + literal(sql) + ']);'
        release_sql = sql.replace('begin;', "begin;\nset local lock_timeout='5s';\nset local statement_timeout='75s';", 1)
        release_sql = release_sql.replace('\ncommit;', '\n' + history + "\nnotify pgrst,'reload schema';\ncommit;")
        query(release_sql)
        print('Applied reviewed email snapshot migration')
    for name in ['leave_notification_balance_snapshot', 'enqueue_leave_notification']:
        args = 'uuid,text' if name == 'leave_notification_balance_snapshot' else 'uuid,text,boolean'
        expected = sql.split('function private.' + name, 1)[1].split('as $$', 1)[1].split('$$;', 1)[0]
        actual = query('select prosrc from pg_proc where oid=' + literal('private.' + name + '(' + args + ')') + '::regprocedure')
        require(actual[0]['prosrc'] == expected, 'Deployed function differs')
    print('Verified both deployed function bodies; no historical email replay')
elif sys.argv[1] == 'inspect':
    print(json.dumps({'migrationRecorded': bool(existing), 'functions': query("select to_regprocedure('private.calculate_employee_leave_accrual(uuid,date)') is not null as accrual_available,to_regprocedure('private.leave_notification_balance_snapshot(uuid,text)') is not null as email_snapshot_available")}))
else:
    raise SystemExit('Use inspect or apply <sha256>')
