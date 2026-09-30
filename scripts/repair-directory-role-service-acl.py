import hashlib
import json
from pathlib import Path
import runpy

release = runpy.run_path(str(Path(__file__).with_name('deploy-people-lifecycle.py')))
require, query = release['require'], release['query']
version = '20260930130001'
name = 'directory_role_service_acl'
sql = (release['ROOT'] / (version + '_' + name + '.sql')).read_text()
require(hashlib.sha256(sql.encode()).hexdigest() == '0e0732496451ae8b7f81b2fe1bb33c3eaf08b386cc34cab2913d4e558c18c3e6', 'Repair source differs')
project = release['api']('')
require(project.get('id') == release['PROJECT'] and project.get('organization_id') == release['ORGANISATION'], 'Wrong MAM target')
entry = release['MIGRATIONS'][2]
require(release['checked_record'](entry, release['source'](entry)), 'Role predecessor not recorded')
repair = (version, name, '')
if not release['checked_record'](repair, sql):
    require(not release['ledger']('20260930150000'), 'Apply ACL repair before offboarding')
    query(release['release_sql'](sql, repair))
require(release['checked_record'](repair, sql), 'Repair ledger mismatch')
require(all(release['schema_state'](2)['functions'].values()), 'Role ACL verification failed')
print(json.dumps({'project': release['PROJECT'], 'aclRepairVerified': version}))
