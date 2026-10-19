import argparse
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / 'deploy/n8n/performance-review-master-sync-v1'
HUB = 'https://mam-team-management-system-ten.vercel.app/api/performance-reviews/master-sync'
GATEWAY = 'https://gateway.maton.ai/microsoft-excel/v1.0'


def shared_source():
    validate = (SOURCES / 'validate-job.mjs').read_text().replace("import {createHash} from 'node:crypto';", "const {createHash}=require('crypto');")
    project = (SOURCES / 'project-row.mjs').read_text().replace("import {array,validateJob,digest} from './validate-job.mjs';", '')
    return (validate + '\n' + project).replace('export ', '')


def build_workflow(target):
    if set(target) != {'enabled', 'singleWriterAdmitted', 'binding'} or type(target['enabled']) is not bool or type(target['singleWriterAdmitted']) is not bool:
        raise ValueError('Invalid Master target configuration')
    if target['enabled']:
        if not target['singleWriterAdmitted'] or target['binding'] is None:
            raise ValueError('Missing Master single-writer admission')
        verifier = "import {validateBinding} from " + json.dumps((SOURCES / 'validate-job.mjs').as_uri()) + ";let s='';for await (const b of process.stdin)s+=b;validateBinding(JSON.parse(s));"
        subprocess.run(['node', '--input-type=module', '-e', verifier], input=json.dumps(target['binding']), text=True, check=True, capture_output=True)
    elif target['binding'] is not None or target['singleWriterAdmitted']:
        raise ValueError('Disabled Master target must remain unbound')
    common = shared_source() + '\nconst config=' + json.dumps(target, ensure_ascii=False) + ';const binding=config.binding;const schema=' + (SOURCES / 'schema.json').read_text() + ';\n'
    nodes = []
    connections = {}

    def node(name, kind, parameters, version=2.0, credential=None):
        value = {'id': 'master-' + str(len(nodes)), 'name': name, 'type': 'n8n-nodes-base.' + kind, 'typeVersion': version, 'position': [len(nodes) * 220, 0], 'retryOnFail': False, 'parameters': parameters}
        if credential:
            value['credentials'] = {'httpHeaderAuth': {'id': '__PARENT_MASTER_' + credential + '_ID__', 'name': '__PARENT_MASTER_' + credential + '_NAME__'}}
        if kind == 'httpRequest':
            value['onError'] = 'continueRegularOutput'
        nodes.append(value)
        return name

    def code(name, body):
        return node(name, 'code', {'mode': 'runOnceForAllItems', 'jsCode': common + body})

    def edge(source, *targets):
        connections[source] = {'main': [[{'node': target, 'type': 'main', 'index': 0}] for target in targets]}

    def gate(name, field):
        return node(name, 'if', {'conditions': {'options': {'caseSensitive': True, 'typeValidation': 'strict', 'version': 2}, 'conditions': [{'id': field, 'leftValue': '={{ $json.' + field + ' }}', 'rightValue': True, 'operator': {'type': 'boolean', 'operation': 'true', 'singleValue': True}}], 'combinator': 'and'}, 'options': {}}, 2.2)

    def http(name, method, url, body=None, excel=False):
        p = {'method': method, 'url': url, 'authentication': 'genericCredentialType', 'genericAuthType': 'httpHeaderAuth', 'options': {'timeout': 15000, 'redirect': {'redirect': {'followRedirects': False}}, 'response': {'response': {'fullResponse': True, 'neverError': True, 'responseFormat': 'json', 'outputPropertyName': 'body'}}}}
        if body is not None:
            p.update({'sendBody': True, 'contentType': 'json', 'specifyBody': 'json', 'jsonBody': body})
        if excel:
            p.update({'sendHeaders': True, 'headerParameters': {'parameters': [{'name': 'Maton-Connection', 'value': target['binding']['connectionId'] if target['binding'] else '__DISABLED__'}]}})
        return node(name, 'httpRequest', p, 4.2, 'GATEWAY' if excel else 'HUB')

    node('Every Five Minutes', 'scheduleTrigger', {'rule': {'interval': [{'field': 'minutes', 'minutesInterval': 5}]}}, 1.2)
    nodes[-1]['disabled'] = not target['enabled']
    code('Initialise', "return [{json:{enabled:config.enabled===true&&config.singleWriterAdmitted===true,status:config.enabled?'pending':'disabled'}}];")
    gate('Enabled?', 'enabled')
    http('Claim', 'POST', HUB, '={{ {phase:"claim"} }}')
    code('Validate Claim', "try {const r=$input.first().json;if(r.statusCode!==200)throw Error('claim_unknown');const body=closed(r.body,['ok','jobs']);if(body.ok!==true||!Array.isArray(body.jobs)||body.jobs.length>1)throw Error('claim_unknown');if(body.jobs.length===0)return [{json:{hasJob:false,status:'idle'}}];const job=validateJob(body.jobs[0],binding);return [{json:{hasJob:true,job,reads:excelRequests(job,binding)}}];}catch{return [{json:{hasJob:false,status:'hold'}}];}")
    gate('Has Job?', 'hasJob')
    code('Done', "return [{json:{status:$input.first().json.status||'hold'}}];")
    edge('Every Five Minutes', 'Initialise')
    edge('Initialise', 'Enabled?')
    edge('Enabled?', 'Claim', 'Done')
    edge('Claim', 'Validate Claim')
    edge('Validate Claim', 'Has Job?')
    kinds = ['item', 'sheet', 'table', 'columns', 'header', 'body', 'keys', 'row']
    for phase in ['pre', 'post']:
        for i, kind in enumerate(kinds):
            name = 'Read ' + phase + ' ' + kind
            url = '={{ ' + json.dumps(GATEWAY) + ' + $("Validate Claim").first().json.reads.find(r=>r.kind===' + json.dumps(kind) + ').path }}'
            http(name, 'GET', url, excel=True)
            if i:
                edge('Read ' + phase + ' ' + kinds[i - 1], name)
    snapshot = lambda phase: "Object.fromEntries(" + json.dumps(kinds) + ".map(k=>{const r=$('Read " + phase + " '+k).first().json;if(r.statusCode!==200)throw Error('read_failed');return [k,r.body];}))"
    finish = "function finishBody(job,outcome,receipt=null){return {phase:'finish',jobId:job.jobId,claimToken:job.claimToken,revision:job.revision,projectionSha256:job.projectionSha256,outcome,receipt};}\n"
    code('Plan', finish + "const job=$('Validate Claim').first().json.job;try{validateSnapshot(job,binding," + snapshot('pre') + ",schema.headers);return [{json:{allowed:true,write:writePlan(job,binding),beginBody:{phase:'begin',jobId:job.jobId,claimToken:job.claimToken,revision:job.revision,projectionSha256:job.projectionSha256,targetFingerprint:job.targetFingerprint}}}];}catch{return [{json:{allowed:false,finishBody:finishBody(job,'prewrite_failed')}}];}")
    gate('Safe Plan?', 'allowed')
    http('Begin', 'POST', HUB, '={{ $json.beginBody }}')
    code('Permit', "const r=$input.first().json;const allowed=r.statusCode===200&&r.body?.ok===true&&r.body?.allowed===true;return [{json:{allowed,status:'hold'}}];")
    gate('Permit Write?', 'allowed')
    http('Patch Row', 'PATCH', '={{ ' + json.dumps(GATEWAY) + ' + $("Plan").first().json.write.path }}', '={{ $("Plan").first().json.write.body }}', True)
    code('Classify', finish + "const job=$('Validate Claim').first().json.job,r=$input.first().json;try{verifyWriteAck(job,binding,{status:r.statusCode,body:r.body});return [{json:{readback:true}}];}catch{return [{json:{readback:false,finishBody:finishBody(job,'unknown')}}];}")
    gate('Known Settled Write?', 'readback')
    code('Verify Readback', finish + "const job=$('Validate Claim').first().json.job;try{validateSnapshot(job,binding," + snapshot('post') + ",schema.headers,{readback:true});return [{json:{finishBody:finishBody(job,'verified',exactReceipt(job,binding))}}];}catch{return [{json:{finishBody:finishBody(job,'readback_pending')}}];}")
    code('Prepare Finish', "const body=$input.first().json.finishBody;closed(body,['phase','jobId','claimToken','revision','projectionSha256','outcome','receipt']);return [{json:{finishBody:body}}];")
    http('Finish', 'POST', HUB, '={{ $json.finishBody }}')
    code('Verify Finish', "const r=$input.first().json;return [{json:{status:r.statusCode===200&&r.body?.ok===true&&r.body?.recorded===true?$('Prepare Finish').first().json.finishBody.outcome:'hold'}}];")
    edge('Has Job?', 'Read pre item', 'Done')
    edge('Read pre row', 'Plan')
    edge('Plan', 'Safe Plan?')
    edge('Safe Plan?', 'Begin', 'Prepare Finish')
    edge('Begin', 'Permit')
    edge('Permit', 'Permit Write?')
    edge('Permit Write?', 'Patch Row', 'Done')
    edge('Patch Row', 'Classify')
    edge('Classify', 'Known Settled Write?')
    edge('Known Settled Write?', 'Read post item', 'Prepare Finish')
    edge('Read post row', 'Verify Readback')
    edge('Verify Readback', 'Prepare Finish')
    edge('Prepare Finish', 'Finish')
    edge('Finish', 'Verify Finish')
    return {'name': 'MAM People Hub - Performance Review Master Sync v1', 'active': False, 'nodes': nodes, 'connections': connections, 'settings': {'executionOrder': 'v1', 'timezone': 'Australia/Melbourne', 'saveDataSuccessExecution': 'none', 'saveDataErrorExecution': 'none', 'saveManualExecutions': False, 'saveExecutionProgress': False}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--target', type=Path, default=SOURCES / 'target.json')
    args = parser.parse_args()
    target = json.loads(args.target.read_text())
    json.dump(build_workflow(target), sys.stdout, ensure_ascii=False)
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
