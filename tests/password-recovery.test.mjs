import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { buildPasswordRecoveryWorkflow } from '../scripts/build-password-recovery-workflow.mjs';

const require = createRequire(import.meta.url);
function load(file, deps = {}) {
  const mod = {exports: {}};
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
  new Function('require','module','exports',code)((id) => deps[id] ?? require(id), mod, mod.exports);
  return mod.exports;
}
const recovery = load('src/lib/password-recovery.ts');
const login = load('src/lib/portal-login.ts');
const userId = '10000000-0000-4000-8000-000000000001';
const requestId = '10000000-0000-4000-8000-000000000002';
const resetToken = '10000000-0000-4000-8000-000000000003';
const token = 'A'.repeat(43);
const password = 'Synthetic-Password-123!';
const hash = value => createHash('sha256').update(value).digest('hex');
const form = values => {const f = new FormData(); for (const [k,v] of Object.entries(values)) f.set(k,v); return f;};
const ok = data => ({data,error:null});
function fixture(options = {}) {
  const previous = {...process.env};
  Object.assign(process.env, {PASSWORD_RECOVERY_WEBHOOK_ORIGIN:'https://n8n.example.test', PASSWORD_RECOVERY_WEBHOOK_URL:'https://n8n.example.test/webhook/mam-people-hub-password-recovery-v1', PASSWORD_RECOVERY_WEBHOOK_SECRET:'synthetic'});
  const calls = [];
  const admin = {rpc: async (name,args) => {
    calls.push([name,args]);
    if (name==='claim_portal_login_attempt') return ok(!options.limited);
    if (name==='issue_portal_password_recovery') return ok(options.unknown ? [] : [{request_id:requestId,recipient:args.p_email}]);
    if (name==='begin_portal_password_recovery') return ok(options.invalid ? [] : [{auth_user_id:userId,reset_token:resetToken}]);
    if (name==='finish_portal_password_recovery') {
      if (options.finishFails || (options.retryFinish && calls.filter(([n])=>n===name).length===1)) return {data:false,error:{message:'synthetic'}};
      return ok(true);
    }
    throw new Error(name);
  }, auth:{admin:{updateUserById:async (id,value)=>{
    calls.push(['password',[id,value]]);
    if (options.uncertain) throw new Error('timeout');
    if (options.providerError) return {error:{message:'synthetic',status:options.providerError}};
    return options.rejected ? {error:{message:'synthetic',status:422}} : ok({user:{id}});
  }}}};
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async (url,init) => {
    calls.push(['email',[url,init]]);
    if (options.mailUncertain) throw new Error('synthetic timeout');
    const p = JSON.parse(init.body);
    return Response.json({ok:true,sent:true,requestId:p.requestId});
  };
  const actions = load('src/app/login/forgot-password/actions.ts', {
    '@/lib/password-recovery':recovery,'@/lib/portal-login':login,'@/lib/supabase/admin':{createAdminClient:()=>admin},
    'next/headers':{headers:async()=>new Headers({'x-real-ip':'192.0.2.2'})},
    'next/navigation':{redirect:url=>{throw new Error('redirect:'+url);}},
  });
  return {actions,calls,cleanup(){globalThis.fetch=fetchBefore;for(const k of Object.keys(process.env))if(!(k in previous))delete process.env[k];Object.assign(process.env,previous);}};
}
test('recovery sends one single-use secret only to the database-confirmed email',async()=>{
  const f=fixture();try {
    const result=await f.actions.requestPasswordRecovery({},form({email:' Person@Company.Example '}));
    assert.equal(result.status,'success');
    const issued=f.calls.find(([n])=>n==='issue_portal_password_recovery')[1];
    const [,init]=f.calls.find(([n])=>n==='email')[1]; const payload=JSON.parse(init.body);
    assert.equal(payload.recipient,'person@company.example');
    const url=new URL(payload.resetUrl); assert.equal(url.search,''); assert.equal(url.origin,recovery.PEOPLE_HUB_ORIGIN);
    const raw=new URLSearchParams(url.hash.slice(1)).get('token'); assert.match(raw,recovery.PASSWORD_RECOVERY_TOKEN_PATTERN);
    assert.equal(issued.p_token_hash,hash(raw)); assert(!JSON.stringify(result).includes(raw));
    assert.equal(init.redirect,'error'); assert(!payload.password);
  }finally{f.cleanup();}
});
test('unknown, limited and uncertain email delivery get the same response',async()=>{
  let expected;for(const opts of [{unknown:true},{limited:true},{mailUncertain:true}]){const f=fixture(opts);try{
    const result=await f.actions.requestPasswordRecovery({},form({email:'person@company.example'}));
    if(expected)assert.deepEqual(result,expected);expected=result;
    if(!opts.mailUncertain)assert(!f.calls.some(([n])=>n==='email'));
  }finally{f.cleanup();}}
});
test('invalid email and unsafe delivery destinations cannot send or issue a token',async()=>{
  const f=fixture();try{
    assert.equal((await f.actions.requestPasswordRecovery({},form({email:'admin'}))).status,'error');
    process.env.PASSWORD_RECOVERY_WEBHOOK_URL='https://attacker.example/webhook/mam-people-hub-password-recovery-v1';
    assert.equal((await f.actions.requestPasswordRecovery({},form({email:'person@company.example'}))).status,'error');
    assert.equal(f.calls.length,0);
  }finally{f.cleanup();}
});
test('reset validates secret, password strength and confirmation before any privileged call',async()=>{
  const f=fixture();try{
    for(const input of [{token:'bad',password,confirmPassword:password},{token,password:'short',confirmPassword:'short'},{token,password,confirmPassword:'different'}])
      assert.equal((await f.actions.resetRecoveredPassword({},form(input))).status,'error');
    assert.equal(f.calls.length,0);
  }finally{f.cleanup();}
});
test('expired or used token cannot reach Auth password update',async()=>{
  const f=fixture({invalid:true});try{
    assert.equal((await f.actions.resetRecoveredPassword({},form({token,password,confirmPassword:password}))).message,recovery.PASSWORD_RECOVERY_INVALID);
    assert(!f.calls.some(([n])=>n==='password'));
  }finally{f.cleanup();}
});
test('successful reset uses the claimed user only and retries finalisation without changing password twice',async()=>{
  const f=fixture({retryFinish:true});try{
    await assert.rejects(f.actions.resetRecoveredPassword({},form({token,password,confirmPassword:password,auth_user_id:'attacker'})),/redirect:\/login\?password=reset/);
    assert.deepEqual(f.calls.find(([n])=>n==='password')[1],[userId,{password}]);
    assert.equal(f.calls.filter(([n])=>n==='password').length,1);
    assert.equal(f.calls.filter(([n])=>n==='finish_portal_password_recovery').length,2);
  }finally{f.cleanup();}
});
test('definite Auth failure cancels claim; uncertain outcomes preserve the claim and never show success',async()=>{
  for(const opts of [{rejected:true},{uncertain:true},{providerError:504},{providerError:503},{providerError:401},{finishFails:true}]){const f=fixture(opts);try{
    const result=await f.actions.resetRecoveredPassword({},form({token,password,confirmPassword:password}));assert.equal(result.status,'error');
    const finishes=f.calls.filter(([n])=>n==='finish_portal_password_recovery');
    if(opts.rejected)assert.equal(finishes[0][1].p_applied,false);
    if(opts.uncertain||opts.providerError)assert.equal(finishes.length,0);
  }finally{f.cleanup();}}
});
const workflow = buildPasswordRecoveryWorkflow({webhookCredential:{id:'synthetic',name:'MAM People Hub - Password Recovery Webhook Header'},outlookCredential:{id:'synthetic-ai',name:'Microsoft Outlook - ai@mobilityaccess.com.au'}});
const execute = (name,p) => new Function('$input',workflow.nodes.find(n=>n.name===name).parameters.jsCode)({first:()=>({json:p})})[0].json;
test('mail workflow rejects untrusted recipients and links, uses AI, and stores no executions',()=>{
  const payload={version:1,requestId,recipient:'person@company.example',resetUrl:`${recovery.PEOPLE_HUB_ORIGIN}/login/reset-password#token=${token}`};
  assert.equal(execute('Validate Password Recovery',{body:payload}).valid,true);
  for(const change of [{recipient:'person@example.test,attacker@example.test'},{resetUrl:'https://attacker.example/#token='+token},{resetUrl:payload.resetUrl+'&extra=bad'},{resetUrl:payload.resetUrl.replace('reset-password','forgot-password')}])
    assert.equal(execute('Validate Password Recovery',{body:{...payload,...change}}).valid,false);
  const message=execute('Build Password Recovery Email',payload);assert(message.bodyContent.includes(payload.resetUrl));
  const sender=workflow.nodes.find(n=>n.name==='Send Password Recovery from AI');assert.equal(sender.credentials.microsoftOutlookOAuth2Api.name,'Microsoft Outlook - ai@mobilityaccess.com.au');
  assert.equal(workflow.settings.saveDataErrorExecution,'none');assert.equal(workflow.settings.saveDataSuccessExecution,'none');assert.equal(workflow.settings.saveExecutionProgress,false);
});
