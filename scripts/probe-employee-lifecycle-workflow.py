import hashlib
import json
import runpy
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERIFIER = Path('/Volumes/UG/MAM/opencode/n8n/scripts/verify.py')
NAME = 'MAM Lifecycle Release Verification 20261023'


def build():
    source = runpy.run_path(str(ROOT / 'scripts/build-performance-review-notifications-workflow.py'))
    hook = 'https://n8n.srv1866578.hstgr.cloud/webhook/mam-people-hub-employee-lifecycle-v1'
    nodes = [source['node']('Start Read Only Probe','scheduleTrigger',{'rule':{'interval':[{'field':'cronExpression','expression':'0 * * * * *'}]}},1.2),
      source['http']('Check Sender And Receipt Store',hook+'-ready',timeout=15000),
      source['node']('Require Readiness','code',{'mode':'runOnceForAllItems','jsCode':"if ($json.statusCode!==200 || $json.body?.ok!==true || $json.body?.ready!==true || $json.body?.sender!=='ai@mobilityaccess.com.au') throw new Error('Lifecycle readiness failed'); return [{json:{ok:true}}];"}),
      source['http']('Reject Invalid Payload',hook,'={{ {version:0} }}',timeout=5000),
      source['node']('Require Invalid Payload Rejection','code',{'mode':'runOnceForAllItems','jsCode':"if ($json.statusCode!==200 || $json.body?.ok!==false || $json.body?.sent!==false || $json.body?.alreadySent!==false) throw new Error('Lifecycle invalid payload gate failed'); return [{json:{ok:true}}];"}),
      source['http']('Check Unauthenticated Cron',source['HUB']+'/api/cron/employee-lifecycle'),
      source['node']('Require Cron Authentication','code',{'mode':'runOnceForAllItems','jsCode':"if ($json.statusCode!==401 || $json.body?.code!=='unauthorized') throw new Error('Lifecycle cron authentication failed'); return [{json:{verified:true}}];"})]
    unauth = nodes[-2]
    unauth.pop('credentials')
    unauth['parameters']['authentication']='none'
    unauth['parameters'].pop('genericAuthType')
    return {'name':NAME,'nodes':nodes,'connections':{a['name']:{'main':[[{'node':b['name'],'type':'main','index':0}]]} for a,b in zip(nodes,nodes[1:])},
      'settings':{'executionOrder':'v1','timezone':'Australia/Melbourne','saveDataSuccessExecution':'none','saveDataErrorExecution':'none','saveManualExecutions':False,'saveExecutionProgress':False,'executionTimeout':60}}


def main():
    args=sys.argv[1:]
    if len(args)!=2 or args[0] not in ('start','inspect','cleanup'): raise SystemExit('Use start|inspect|cleanup JOURNAL')
    journal=Path(args[1])
    verifier=runpy.run_path(str(VERIFIER))
    if verifier['main']()!=0: raise SystemExit('MAM connection unverified')
    config=verifier['load_local_env']()
    if config['N8N_INSTANCE_LABEL']!='MAM' or config['N8N_BASE_URL']!='https://n8n.srv1866578.hstgr.cloud': raise SystemExit('MAM target mismatch')
    opener=verifier['build_opener'](verifier['NoRedirect']())
    expected=build()
    def api(path,method='GET',body=None):
        req=urllib.request.Request(config['N8N_BASE_URL']+'/api/v1/'+path,method=method,
          headers={'X-N8N-API-KEY':config['N8N_API_KEY'],'Content-Type':'application/json'},data=None if body is None else json.dumps(body).encode())
        with opener.open(req,timeout=30) as r:
            raw=r.read()
            return json.loads(raw) if raw else None
    def matches(value):
        return all(value.get(k)==expected[k] for k in ('name','nodes','connections'))
    if args[0]=='start':
        with journal.open('x') as handle: json.dump({'state':'create_entered','name':NAME},handle)
        created=api('workflows','POST',expected)
        state={'state':'created','id':created['id'],'name':NAME,'sha256':hashlib.sha256(json.dumps(expected,sort_keys=True).encode()).hexdigest()}
        journal.write_text(json.dumps(state))
        if not matches(api('workflows/'+state['id'])): raise SystemExit('Probe source readback differs')
        state['state']='activation_entered';journal.write_text(json.dumps(state))
        api('workflows/'+state['id']+'/activate','POST',{})
        state['state']='active';journal.write_text(json.dumps(state))
        print(json.dumps({'probeId':state['id'],'active':True,'sendsEmail':False}))
    else:
        state=json.loads(journal.read_text())
        if state.get('name')!=NAME or state.get('state') not in ('created','activation_entered','active'): raise SystemExit('Probe journal differs')
        actual=api('workflows/'+state['id'])
        if not matches(actual): raise SystemExit('Probe changed; preserve it')
        executions=api('executions?workflowId='+state['id']+'&limit=5&includeData=false')['data']
        if args[0]=='inspect':
            print(json.dumps({'probeId':state['id'],'active':actual['active'],'executions':[{'id':e['id'],'status':e.get('status'),'finished':e.get('finished')} for e in executions]}))
        else:
            if not any(e.get('status')=='success' for e in executions): raise SystemExit('No successful probe; preserve for diagnosis')
            if actual['active']: api('workflows/'+state['id']+'/deactivate','POST',{})
            api('workflows/'+state['id'],'DELETE')
            state['state']='verified_and_removed';journal.write_text(json.dumps(state))
            print(json.dumps({'probeVerified':True,'temporaryProbeRemoved':True,'sendsEmail':False}))


if __name__=='__main__':
    try: main()
    except Exception: raise SystemExit('Lifecycle probe unverified; preserve journal and inspect before retry') from None
