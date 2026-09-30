import hashlib
import json
from pathlib import Path
import runpy

release = runpy.run_path(str(Path(__file__).with_name('deploy-people-lifecycle.py')))
require, query = release['require'], release['query']
version = '20260930150001'
name = 'offboarding_schedule_service_acl'
sql = (release['ROOT'] / (version + '_' + name + '.sql')).read_text()
require(hashlib.sha256(sql.encode()).hexdigest() == 'ffdb719b0cd30c95ca793c171e968bb2ca7fb2c11f04e3a9f22cdb827dfe428e', 'Repair source differs')
project = release['api']('')
require(project.get('id') == release['PROJECT'] and project.get('organization_id') == release['ORGANISATION'], 'Wrong MAM target')
entry = release['MIGRATIONS'][3]
require(release['checked_record'](entry, release['source'](entry)), 'Offboarding predecessor not recorded')
repair = (version, name, '')
if not release['checked_record'](repair, sql):
    query(release['release_sql'](sql, repair))
require(release['checked_record'](repair, sql), 'Repair ledger mismatch')
state = release['schema_state'](3)
require(all(state['functions'].values()) and all(state['tables'].values()), 'Offboarding ACL verification failed')
print(json.dumps({'project': release['PROJECT'], 'aclRepairVerified': version}))
