import hashlib
import json
import re
import runpy
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERIFIER = Path('/Volumes/UG/MAM/opencode/n8n/scripts/verify.py')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def main():
    args = sys.argv[1:]
    if not args or args[0] not in ('inspect', 'create', 'activate'):
        raise SystemExit('Use inspect | create SHA JOURNAL | activate ID SHA JOURNAL')
    expected = runpy.run_path(str(ROOT / 'scripts/build-employee-lifecycle-workflow.py'))['build_workflow']()
    digest = hashlib.sha256(canonical(expected)).hexdigest()
    verifier = runpy.run_path(str(VERIFIER))
    if verifier['main']() != 0:
        raise SystemExit('MAM verification failed')
    config = verifier['load_local_env']()
    origin = config['N8N_BASE_URL']
    if config['N8N_INSTANCE_LABEL'] != 'MAM' or origin != 'https://n8n.srv1866578.hstgr.cloud':
        raise SystemExit('MAM workflow target mismatch')
    opener = verifier['build_opener'](verifier['NoRedirect']())

    def api(path, method='GET', body=None):
        req = urllib.request.Request(origin+'/api/v1/'+path, method=method,
            headers={'X-N8N-API-KEY':config['N8N_API_KEY'],'Content-Type':'application/json'},
            data=None if body is None else canonical(body))
        with opener.open(req, timeout=30) as response:
            return json.load(response)

    def matches(actual):
        return (actual.get('name') == expected['name'] and actual.get('nodes') == expected['nodes']
            and actual.get('connections') == expected['connections']
            and all(actual.get('settings', {}).get(k) == v for k,v in expected['settings'].items()))

    found = []
    cursor = None
    from urllib.parse import quote
    while True:
        page = api('workflows?limit=100' + ('&cursor='+quote(cursor, safe='') if cursor else ''))
        for workflow in page['data']:
            if workflow['name'] == expected['name'] or any(n.get('parameters',{}).get('path','').startswith('mam-people-hub-employee-lifecycle-v1') for n in workflow.get('nodes',[])):
                found.append(workflow)
        cursor = page.get('nextCursor')
        if not cursor:
            break
    if args[0] == 'inspect':
        if len(args) != 1: raise SystemExit('Invalid inspect arguments')
        print(json.dumps({'sourceSha256':digest,'matches':[{'id':w['id'],'active':w['active'],'sourceMatches':matches(w)} for w in found]}))
        return
    if args[0] == 'create':
        if len(args) != 3 or args[1] != digest or found: raise SystemExit('Create preflight differs')
        journal = Path(args[2])
        with journal.open('x') as handle: json.dump({'operation':'create','state':'entered','sourceSha256':digest},handle)
        created = api('workflows','POST',expected)
        workflow_id = created.get('id')
        if not isinstance(workflow_id,str) or not re.fullmatch('[A-Za-z0-9_-]{1,64}',workflow_id): raise SystemExit('Create result unverified; inspect, never retry')
        actual = api('workflows/'+workflow_id)
        if not matches(actual) or actual.get('active') is not False: raise SystemExit('Created workflow differs')
        journal.write_text(json.dumps({'operation':'create','state':'verified','id':workflow_id,'sourceSha256':digest}))
        print(json.dumps({'id':workflow_id,'active':False,'sourceMatches':True}))
    else:
        if len(args) != 4 or args[2] != digest or len(found) != 1 or found[0]['id'] != args[1] or not matches(found[0]): raise SystemExit('Activation preflight differs')
        workflow_id = args[1]
        if found[0]['active']: raise SystemExit('Already active; inspect instead')
        journal = Path(args[3])
        with journal.open('x') as handle: json.dump({'operation':'activate','state':'entered','id':workflow_id,'sourceSha256':digest},handle)
        api('workflows/'+workflow_id+'/activate','POST',{})
        actual = api('workflows/'+workflow_id)
        if not matches(actual) or actual.get('active') is not True: raise SystemExit('Activation unverified; inspect, never retry')
        journal.write_text(json.dumps({'operation':'activate','state':'verified','id':workflow_id,'sourceSha256':digest}))
        print(json.dumps({'id':workflow_id,'active':True,'sourceMatches':True}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('Lifecycle workflow operation unverified; preserve journal and inspect before any retry') from None
