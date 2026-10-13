import { HR_EMAIL_SIGNATURE_HTML } from './hr-email-signature.mjs';
const TO = 'marketing@mobilityaccess.com.au';
const RECEIPTS = 'https://mam-team-management-system-ten.vercel.app/api/internal/integrations/notifications/receipts';
const AUTH = { id:'tGtpwegru8OxtdCt',name:'MAM Team Management - Notification Webhook Header' };
export function buildSubscriptionRequestMailWorkflow({outlookCredential,cronCredential}={}) {
  if (!outlookCredential?.id || !outlookCredential?.name) throw Error('Verified MAM Outlook credential required.');
  if (!cronCredential?.id || !cronCredential?.name) throw Error('Scoped subscription-request cron credential required.');
  let sequence=0;
  const identifier=()=>"e5140000-0000-4000-8000-"+String(++sequence).padStart(12,'0');
  const node=(name,type,parameters,credentials={})=>({id:identifier(),name,type:'n8n-nodes-base.'+type,typeVersion:{webhook:2.1,code:2,if:2.2,httpRequest:4.2,microsoftOutlook:2}[type],position:[0,0],parameters,credentials});
  const code=(name,jsCode)=>node(name,'code',{mode:'runOnceForAllItems',jsCode});
  const condition=(name,field)=>node(name,'if',{conditions:{options:{caseSensitive:true,leftValue:'',typeValidation:'strict',version:2},conditions:[{id:identifier(),leftValue:`={{ $json.${field} }}`,rightValue:'',operator:{type:'boolean',operation:'true',singleValue:true}}],combinator:'and'},options:{}});
  const http=(name,jsonBody)=>node(name,'httpRequest',{method:'POST',url:RECEIPTS,authentication:'genericCredentialType',genericAuthType:'httpHeaderAuth',sendBody:true,contentType:'json',specifyBody:'json',jsonBody,options:{redirect:{redirect:{followRedirects:false}},timeout:10000,response:{response:{responseFormat:'json',neverError:false,fullResponse:false}}}},{httpHeaderAuth:AUTH});
  const nodes=[
    node('Receive Subscription Request','webhook',{authentication:'headerAuth',httpMethod:'POST',path:'mam-subscription-request-mail-v1',responseMode:'lastNode',options:{}},{httpHeaderAuth:AUTH}),
    code('Validate Subscription Request',`const p=$input.first().json.body;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).sort().join(',')===keys.sort().join(',');
const text=v=>typeof v==='string'&&v.length<=4000;
const email=/^[^\\s@,;]+@[^\\s@,;]+\\.[^\\s@,;]+$/;
const key=/^subscription-request:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-9][0-9]*$/;
const fields=['service','plan','purpose','company','duration','billing','currency','quoteCents','audEstimateCents','noQuoteReason','intendedUsers'];
const valid=exact(p,['version','event','deliveryId','applicantName','applicantWorkEmail','request'])&&JSON.stringify(p).length<=24000
&&p.version===1&&p.event==='subscription-request-submitted'&&key.test(p.deliveryId)
&&text(p.applicantName)&&p.applicantName.trim()&&typeof p.applicantWorkEmail==='string'&&p.applicantWorkEmail.length<=254&&email.test(p.applicantWorkEmail)&&p.applicantWorkEmail===p.applicantWorkEmail.trim().toLowerCase()
&&exact(p.request,fields)&&fields.filter(k=>!k.endsWith('Cents')).every(k=>p.request[k]===null||text(p.request[k]))
&&['quoteCents','audEstimateCents'].every(k=>p.request[k]===null||(Number.isSafeInteger(p.request[k])&&p.request[k]>=0&&p.request[k]<=100000000))
&&text(p.request.service)&&p.request.service.trim()&&['mam','equipsy','both'].includes(p.request.company)&&/^[A-Z]{3}$/.test(p.request.currency||'');
if(!valid)return [{json:{valid:false,code:'invalid_payload'}}];
return [{json:{...p,valid:true,actualRecipient:${JSON.stringify(TO)},ccRecipients:p.applicantWorkEmail===${JSON.stringify(TO)}?'':p.applicantWorkEmail}}];`),
    condition('Valid Subscription Request?','valid'),
    http('Reserve Subscription Delivery',"={{ {action:'reserve',eventKey:$json.deliveryId,recipient:$json.actualRecipient,cc:$json.ccRecipients,legacyEventKey:null} }}"),
    code('Gate Subscription Delivery',`const c=$('Validate Subscription Request').first().json;const r=$input.first().json;
const token=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const shouldSend=r?.outcome==='send'&&r.eventKey===c.deliveryId&&token.test(r.deliveryToken||'');
const alreadySent=r?.outcome==='duplicate'&&r.ok===true&&r.alreadySent===true&&r.eventKey===c.deliveryId&&r.actualRecipient===c.actualRecipient&&r.actualCcRecipients===c.ccRecipients;
return [{json:{...c,shouldSend,alreadySent,deliveryToken:shouldSend?r.deliveryToken:null}}];`),
    condition('Send Subscription Email?','shouldSend'),
    code('Build Subscription Email',`const c=$input.first().json;const r=c.request;
const escape=v=>String(v??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const row=(label,value)=>'<li><strong>'+label+':</strong> '+escape(value)+'</li>';
const money=(cents,currency)=>cents===null?'Not provided':new Intl.NumberFormat('en-AU',{style:'currency',currency}).format(cents/100);
const details=[row('Applicant',c.applicantName),row('Company',{mam:'MAM',equipsy:'Equipsy',both:'MAM and Equipsy'}[r.company]),row('Subscription',r.service),r.plan?row('Plan',r.plan):'',row('Quoted cost',money(r.quoteCents,r.currency)),r.quoteCents===null?row('Quote unavailable',r.noQuoteReason):'',row('AUD estimate',money(r.audEstimateCents,'AUD')),row('Billing',{monthly:'Monthly',annual:'Annual',one_off:'One-off',other:'Other'}[r.billing]||r.billing),row('Usage duration',r.duration),row('Intended users',r.intendedUsers),row('Reason',r.purpose),row('Status','Pending review')].join('');
const bodyContent='<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.6;color:#22302b"><p>MAM subscription notification</p><p>A subscription request has been submitted and is awaiting review.</p><p><strong>Subscription request details</strong></p><ul>'+details+'</ul><p>Please review the request in People Hub. The applicant has been copied into this notification.</p><p><a href="https://mam-team-management-system-ten.vercel.app/?view=people&amp;tab=tasks" style="display:inline-block;padding:10px 16px;background:#ef6c24;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">People Hub</a></p><p>Thanks,<br>People Hub</p>'+${JSON.stringify(HR_EMAIL_SIGNATURE_HTML)}+'</div>';
return [{json:{...c,subject:'[MAM] Subscription request submitted: '+c.applicantName.replace(/[\\r\\n]/g,' ').slice(0,80)+' — '+r.service.replace(/[\\r\\n]/g,' ').slice(0,100),bodyContent}}];`),
    node('Send Subscription Email','microsoftOutlook',{resource:'message',operation:'send',toRecipients:TO,subject:'={{ $json.subject }}',bodyContent:'={{ $json.bodyContent }}',additionalFields:{bodyContentType:'html',ccRecipients:'={{ $json.ccRecipients }}',saveToSentItems:true}},{microsoftOutlookOAuth2Api:outlookCredential}),
    code('Build Subscription Confirmation',`const c=$('Build Subscription Email').first().json;const p=$input.first().json;return [{json:{action:'confirm',eventKey:c.deliveryId,recipient:c.actualRecipient,cc:c.ccRecipients,deliveryToken:c.deliveryToken,providerReceipt:{accepted:true,messageId:typeof p.id==='string'&&p.id?p.id:null,requestId:null,statusCode:202}}}];`),
    http('Confirm Subscription Delivery','={{ $json }}'),
    code('Validate Subscription Confirmation',`const c=$('Build Subscription Email').first().json;const r=$input.first().json;
const ok=r?.ok===true&&r.sent===true&&r.eventKey===c.deliveryId&&r.actualRecipient===c.actualRecipient&&r.actualCcRecipients===c.ccRecipients;
return [{json:ok?{ok:true,sent:true,alreadySent:false,deliveryId:c.deliveryId,actualRecipient:c.actualRecipient,actualCcRecipients:c.ccRecipients}:{ok:false,sent:false,alreadySent:false,deliveryId:c.deliveryId}}];`),
    condition('Already Delivered?','alreadySent'),
    code('Return Subscription Duplicate',`return [{json:{ok:true,sent:false,alreadySent:true,deliveryId:$json.deliveryId,actualRecipient:$json.actualRecipient,actualCcRecipients:$json.ccRecipients}}];`),
    code('Return Subscription Rejection',`return [{json:{ok:false,sent:false,alreadySent:false,code:'rejected'}}];`),
  ];
  const connections={};const connect=(from,...targets)=>{connections[from]={main:targets.map(t=>[{node:t,type:'main',index:0}])};};
  connect('Receive Subscription Request','Validate Subscription Request');connect('Validate Subscription Request','Valid Subscription Request?');connect('Valid Subscription Request?','Reserve Subscription Delivery','Return Subscription Rejection');
  connect('Reserve Subscription Delivery','Gate Subscription Delivery');connect('Gate Subscription Delivery','Send Subscription Email?');connect('Send Subscription Email?','Build Subscription Email','Already Delivered?');
  connect('Build Subscription Email','Send Subscription Email');connect('Send Subscription Email','Build Subscription Confirmation');connect('Build Subscription Confirmation','Confirm Subscription Delivery');connect('Confirm Subscription Delivery','Validate Subscription Confirmation');connect('Already Delivered?','Return Subscription Duplicate','Return Subscription Rejection');
  nodes.push(node('Retry queued submissions every five minutes','scheduleTrigger',{rule:{interval:[{field:'minutes',minutesInterval:5}]}}));
  nodes.at(-1).typeVersion=1.2;
  nodes.push(node('Dispatch queued subscription mail','httpRequest',{method:'GET',url:'https://mam-team-management-system-ten.vercel.app/api/cron/subscription-requests',authentication:'genericCredentialType',genericAuthType:'httpHeaderAuth',options:{timeout:300000,redirect:{redirect:{followRedirects:false}}}},{httpHeaderAuth:cronCredential}));
  connect('Retry queued submissions every five minutes','Dispatch queued subscription mail');
  nodes.forEach((n,i)=>{n.position=[i*180,0];});
  return {name:'MAM People Hub - Subscription Request Email (Marketing)',nodes,connections,settings:{executionOrder:'v1',timezone:'Australia/Melbourne',saveDataSuccessExecution:'none',saveDataErrorExecution:'none',saveExecutionProgress:false}};
}
