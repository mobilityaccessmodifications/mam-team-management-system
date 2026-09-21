"""Apply reviewed reliability migrations through the MAM credential helper."""
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.request
PROJECT='xtwlrjqbusadghavchqm'
ORG='fwlmbmospuwoaosffvmw'
ROOT=Path(__file__).resolve().parents[1]
VERSIONS={'20260921190000':'reliable_leave_submission','20260921191000':'check_in_retry_catchup'}
def api(path,body=None):
    r=urllib.request.Request('https://api.supabase.com/v1/projects/'+PROJECT+path,
        headers={'Authorization':'Bearer '+os.environ['SUPABASE_ACCESS_TOKEN'],'Content-Type':'application/json','User-Agent':'supabase-cli/2.54.11'},
        data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(r,timeout=90) as f:return json.load(f)
def query(sql):return api('/database/query',{'query':sql})
def literal(s):return "'"+s.replace("'","''")+"'"
def main():
    p=api('')
    if p['id']!=PROJECT or p['organization_id']!=ORG:raise SystemExit('MAM target mismatch')
    print('Verified MAM project',PROJECT)
    if len(sys.argv)<2 or sys.argv[1] not in ['inspect','apply']:raise SystemExit('Use inspect or apply <version> <sha256>')
    if sys.argv[1]=='inspect':
        print(json.dumps(query("select version from supabase_migrations.schema_migrations where version >= '20260921170000' order by version")))
        return
    if len(sys.argv)!=4 or sys.argv[2] not in VERSIONS:raise SystemExit('Invalid reviewed migration')
    v=sys.argv[2];name=VERSIONS[v];sql=(ROOT/'supabase/migrations'/f'{v}_{name}.sql').read_text()
    if hashlib.sha256(sql.encode()).hexdigest()!=sys.argv[3]:raise SystemExit('Reviewed migration differs')
    existing=query('select statements from supabase_migrations.schema_migrations where version='+literal(v))
    if existing:
        if existing[0]['statements']!=[sql]:raise SystemExit('Recorded migration differs')
    else:
        if sql.count('\ncommit;')!=1:raise SystemExit('Unexpected migration structure')
        history='insert into supabase_migrations.schema_migrations(version,name,statements) values('+literal(v)+','+literal(name)+',ARRAY['+literal(sql)+']);'
        release=sql.replace('begin;','begin;\nset local lock_timeout=\'5s\';\nset local statement_timeout=\'75s\';',1).replace('\ncommit;','\n'+history+"\nnotify pgrst,'reload schema';\ncommit;")
        query(release)
    print('Verified migration recorded',v)
if __name__=='__main__':main()
