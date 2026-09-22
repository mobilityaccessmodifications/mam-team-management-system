"""Reassert and verify the reviewer-aware MAM email resolver. Never replay mail."""
import hashlib
import json
from pathlib import Path
import runpy
import sys

base = runpy.run_path(str(Path(__file__).with_name('deploy-reliability-migrations.py')))
query, api, literal = base['query'], base['api'], base['literal']
version = '20260922170000'
name = 'restore_authorised_leave_email_route'
sql = (base['ROOT'] / 'supabase/migrations' / f'{version}_{name}.sql').read_text()
expected_body = sql.split('as $$', 1)[1].split('$$;', 1)[0]

def require(condition, message):
    if not condition:
        raise SystemExit(message)

def inspect():
    result = query("""select
      (select prosrc from pg_proc where oid='public.resolve_leave_notification_manager(uuid)'::regprocedure) body,
      has_function_privilege('service_role','public.resolve_leave_notification_manager(uuid)','EXECUTE') service_access,
      not has_function_privilege('authenticated','public.resolve_leave_notification_manager(uuid)','EXECUTE')
        and not has_function_privilege('anon','public.resolve_leave_notification_manager(uuid)','EXECUTE') private_access""")[0]
    result['definition_matches'] = result.pop('body') == expected_body
    print(json.dumps(result))
    return result

project = api('')
require(project.get('id') == base['PROJECT'] and project.get('organization_id') == base['ORG'], 'Wrong MAM target')
operation = sys.argv[1] if len(sys.argv) > 1 else ''
require(operation in ('inspect', 'apply'), 'Use inspect or apply <reviewed-sha256>')
if operation == 'apply':
    require(len(sys.argv) == 3 and hashlib.sha256(sql.encode()).hexdigest() == sys.argv[2], 'Reviewed migration differs')
    require(query("select version from supabase_migrations.schema_migrations where version='20260910041150'"), 'Manager reviewer predecessor missing')
    existing = query('select statements from supabase_migrations.schema_migrations where version=' + literal(version))
    if existing:
        require(existing[0]['statements'] == [sql], 'Recorded migration differs')
    else:
        require(sql.count('\ncommit;') == 1, 'Unexpected migration transaction')
        history = 'insert into supabase_migrations.schema_migrations(version,name,statements) values(' + literal(version) + ',' + literal(name) + ',ARRAY[' + literal(sql) + ']);'
        query(sql.replace('begin;', "begin; set local lock_timeout='5s'; set local statement_timeout='60s';", 1).replace('\ncommit;', '\n' + history + "\nnotify pgrst,'reload schema';\ncommit;"))
result = inspect()
if operation == 'apply':
    require(all(result.values()), 'Resolver read-back or privileges differ')
