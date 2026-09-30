import hashlib
import json
from pathlib import Path
import re
import runpy
import sys

release = runpy.run_path(str(Path(__file__).with_name('deploy-people-lifecycle.py')))
require, query = release['require'], release['query']
entry = ('20260930170000', 'directory_overseas_employment', 'fe6a535d946d28808bbfa041ab9a0b8760ed8c3c675312210305a2aded1de89e')
sql = release['source'](entry)
args = sys.argv[1:]
require(args == ['inspect'] or args == ['apply', entry[2]], 'Use inspect or apply <reviewed-sha256>')
project = release['api']('')
require(project.get('id') == release['PROJECT'] and project.get('organization_id') == release['ORGANISATION'], 'Wrong MAM target')
predecessor = release['ledger']('20260930150001')
require(len(predecessor) == 1 and predecessor[0]['name'] == 'offboarding_schedule_service_acl', 'Lifecycle predecessor missing')
recorded = release['checked_record'](entry, sql)
functions = [('private.normalise_employee_employment_type(text)', '20260904090000_employment_leave_entitlements.sql'), ('private.enforce_leave_request_employment_policy()', '20260904140000_historical_leave_import_support.sql')]
def verify(applied):
    for signature, previous in functions:
        source = sql if applied else (release['ROOT'] / previous).read_text()
        name = signature.split('(')[0]
        match = re.search(r'create(?: or replace)? function ' + re.escape(name) + r'\([^;]*?as \$\$(.*?)\$\$;', source, re.S | re.I)
        if match is None:
            raise SystemExit('Source function missing')
        rows = query('select prosrc,proacl::text as acl,prosecdef,proconfig from pg_proc where oid=to_regprocedure(' + release['literal'](signature) + ')')
        require(len(rows) == 1 and rows[0]['prosrc'] == match.group(1), 'Function body drift: ' + signature)
        require(rows[0]['proconfig'] == ['search_path=""'], 'Function search path differs')
        require(rows[0]['prosecdef'] == (signature == 'private.enforce_leave_request_employment_policy()'), 'Function security mode differs')
        denied = query('select not has_function_privilege(\'anon\',oid,\'EXECUTE\') and not has_function_privilege(\'authenticated\',oid,\'EXECUTE\') as denied from pg_proc where oid=to_regprocedure(' + release['literal'](signature) + ')')
        require(len(denied) == 1 and denied[0]['denied'], 'Private function ACL differs')
    rows = query("select pg_get_constraintdef(oid) definition from pg_constraint where (conrelid='private.employee_directory_details'::regclass and conname='employee_directory_details_employment_type_check') or (conrelid='public.leave_requests'::regclass and conname='leave_requests_employment_type_snapshot_check')")
    require(len(rows) == 2 and all(('overseas' in r['definition']) == applied for r in rows), 'Constraint state differs')
verify(recorded)
if args[0] == 'apply' and not recorded:
    query(release['release_sql'](sql, entry))
    require(release['checked_record'](entry, sql), 'Ledger readback differs')
    verify(True)
    recorded = True
print(json.dumps({'verifiedProject': release['PROJECT'], 'version': entry[0], 'recorded': recorded, 'sourceAndConstraintsVerified': True}))
