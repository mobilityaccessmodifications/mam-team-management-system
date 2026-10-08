import { build } from 'esbuild';
import { existsSync, mkdtempSync,readFileSync,rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {startCluster,stopCluster,sql} from '../scripts/local-test-postgres.mjs';
import {loadModule} from './helpers/contact-lifetime-harness.mjs';
assert.ok(existsSync('src/components/subscription-requests.tsx'),'Requests component is not implemented');
const scratch=mkdtempSync(path.join(tmpdir(),'mam-sr-browser-'));
const socket=startCluster(), database='mam_test_sr_browser';
let server;
try {
  const replay=spawnSync(process.execPath,['scripts/test-migration-replay.mjs',socket,database],{encoding:'utf8',timeout:180000});
  assert.equal(replay.status,0,replay.stderr);
  const fixture=readFileSync('tests/unified-role-fixture.sql','utf8').replace('\\ir sql-test-auth.sql',()=>readFileSync('tests/sql-test-auth.sql','utf8'));
  sql(socket,database,fixture+"\nupdate private.subscription_request_config set enabled=true,approver_user_id='a1000000-0000-4000-8000-000000000004',approver_person_id='a1000000-0000-4000-8000-000000000004';");
  const actions=loadModule('src/app/subscription-requests/actions.ts',{'@/lib/supabase/server':{createClient:async()=>({auth:{getUser:async()=>({data:{user:{id:'a1000000-0000-4000-8000-000000000004'}},error:null})},rpc:async(name,args={})=>{
    assert.ok(['sr_workspace','sr_mutate','sr_download'].includes(name));
    const literal=value=>value==null?'null':typeof value==='number'?String(value):"'"+(typeof value==='object'?JSON.stringify(value):value).replaceAll("'","''")+"'";
    const parameters=Object.entries(args).map(([key,value])=>key+'=>'+literal(value)).join(',');
    try { const text=sql(socket,database,"begin; select set_config('request.jwt.claim.sub','a1000000-0000-4000-8000-000000000004',true); select set_config('request.jwt.claims','{\"sub\":\"a1000000-0000-4000-8000-000000000004\",\"iat\":4102444800,\"is_anonymous\":false}',true); set local role authenticated; select public."+name+'('+parameters+'); commit;'); return {data:JSON.parse(text.trim().split('\n').at(-1)),error:null}; }
    catch(error) { return {data:null,error:{code:/ERROR:\s+(\w{5}):/.exec(error.message)?.[1]??'XX000'}}; }
  }})}});
  server=createServer(async(req,res)=>{
    if(req.method==='POST' && req.url==='/fixture/revocation-seed') {
      try {
        const value=sql(socket,database,"begin; select set_config('request.jwt.claim.sub','a1000000-0000-4000-8000-000000000013',true); select set_config('request.jwt.claims','{\"sub\":\"a1000000-0000-4000-8000-000000000013\",\"iat\":4102444800,\"is_anonymous\":false}',true); set local role authenticated; select public.sr_mutate('b1000000-0000-4000-8000-000000000090',0,'submit','{\"kind\":\"new_purchase\",\"service\":\"Synthetic revoked request\",\"purpose\":\"Work\",\"company\":\"mam\",\"payer\":\"MAM\",\"duration\":\"Year\",\"billing\":\"annual\",\"currency\":\"AUD\",\"tax\":\"Inclusive\",\"quoteCents\":1,\"audEstimateCents\":1,\"payment\":\"non_card\",\"intendedUsers\":\"Team\"}'); commit;");
        res.setHeader('Content-Type','application/json');res.end(value.trim().split('\n').at(-1));
      } catch {res.writeHead(500);res.end('{}');} return;
    }
    if(req.method==='POST' && (req.url==='/fixture/revoke' || req.url==='/fixture/restore')) {
      try {
        const revoked=req.url==='/fixture/revoke';
        const approver=revoked?'a1000000-0000-4000-8000-000000000013':'a1000000-0000-4000-8000-000000000004';
        sql(socket,database,`begin; update public.profiles set app_role='${revoked?'employee':'admin'}' where id='a1000000-0000-4000-8000-000000000004'; update private.subscription_request_config set approver_user_id='${approver}',approver_person_id='${approver}' where singleton; commit;`);
        res.end('{}');
      } catch {res.writeHead(500);res.end('{}');} return;
    }
    if(req.method==='POST' && req.url==='/action') {
      let body=''; for await(const chunk of req) {body+=chunk; if(body.length>1000000) {res.writeHead(413);res.end();return;}}
      try {const {name,args}=JSON.parse(body); assert.ok(['loadSubscriptionRequests','mutateSubscriptionRequest','downloadRequestEvidence'].includes(name)); const result=await actions[name](...args); res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));} catch {res.writeHead(500);res.end('{}');} return;
    }
    const asset=req.url==='/fixture.js'?'fixture.js':req.url==='/fixture.css'?'fixture.css':null;
    res.setHeader('Content-Type',asset?.endsWith('.js')?'text/javascript':asset?'text/css':'text/html');
    res.end(asset?readFileSync(path.join(scratch,asset)):'<!doctype html><html><meta charset="utf-8"><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
  });
  await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{SubscriptionRequests}from'./src/components/subscription-requests';import{loadSubscriptionRequests}from'./src/app/subscription-requests/actions';loadSubscriptionRequests().then(r=>createRoot(document.getElementById('root')).render(r.ok?<SubscriptionRequests initial={r.data}/>:<p>{r.message}</p>));`,resolveDir:process.cwd(),sourcefile:'fixture.jsx',loader:'jsx'},bundle:true,outfile:path.join(scratch,'fixture.js'),jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},alias:{'@':path.resolve('src')},plugins:[{name:'actual-server-action-boundary',setup(b){b.onLoad({filter:/subscription-requests\/actions\.ts$/},()=>({loader:'js',contents:`window.srCalls=[];async function call(name,args){if(name==='mutateSubscriptionRequest'){window.srCalls.push(args);if(window.srHold)await new Promise(r=>window.srRelease=r);if(window.srUncertain)return{ok:false,message:'Reload before retrying.',uncertain:true};}return fetch('/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,args})}).then(r=>r.json());}export const loadSubscriptionRequests=(...a)=>call('loadSubscriptionRequests',a);export const mutateSubscriptionRequest=(...a)=>call('mutateSubscriptionRequest',a);export const downloadRequestEvidence=(...a)=>call('downloadRequestEvidence',a);`}));}}]});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const child=spawn(process.execPath,['node_modules/@playwright/test/cli.js','test','--config=tests/subscription-requests-playwright.config.mjs'],{env:{...process.env,MAM_SR_ORIGIN:`http://127.0.0.1:${server.address().port}`,MAM_SR_OUTPUT_DIR:path.join(scratch,'playwright'),PLAYWRIGHT_BROWSERS_PATH:path.resolve('node_modules/.cache/ms-playwright')},stdio:'inherit',timeout:180000});
  process.exitCode=await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);})??1;
} finally { if(server) await new Promise(resolve=>server.close(resolve)); stopCluster(socket); rmSync(scratch,{recursive:true,force:true}); }
