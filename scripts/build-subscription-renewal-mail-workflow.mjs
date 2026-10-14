import { buildSubscriptionReviewMailWorkflow } from './build-subscription-review-mail-workflow.mjs';
import { HR_EMAIL_SIGNATURE_HTML } from './hr-email-signature.mjs';

export function buildSubscriptionRenewalMailWorkflow({ outlookCredential } = {}) {
  const workflow = buildSubscriptionReviewMailWorkflow({ outlookCredential });
  workflow.name = 'MAM People Hub - Subscription Renewal Reminders';
  const rename = value => value.replaceAll('Subscription Review', 'Subscription Renewal');
  workflow.nodes.forEach(n => {
    n.name = rename(n.name);
    n.id = 'e5180000' + n.id.slice(8);
    if (n.parameters.jsCode) n.parameters.jsCode = rename(n.parameters.jsCode);
  });
  workflow.connections = Object.fromEntries(Object.entries(workflow.connections).map(([name, value]) => [
    rename(name), { main: value.main.map(branch => branch.map(edge => ({ ...edge, node: rename(edge.node) }))) },
  ]));
  const node = name => workflow.nodes.find(n => n.name === name);
  node('Receive Subscription Renewal').parameters.path = 'mam-subscription-renewal-mail-v1';
  node('Receive Subscription Renewal').webhookId = 'e5180000-0000-4000-8000-000000000001';
  node('Validate Subscription Renewal').parameters.jsCode = `const p=$input.first().json.body;
const keys=['version','event','deliveryId','serviceName','nextRenewalOn','phase','toRecipients'];
const object=p&&typeof p==='object'&&!Array.isArray(p);
const email=/^[^\\s@,;]+@[^\\s@,;]+\\.[^\\s@,;]+$/;
const key=/^subscription-renewal:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])):(upcoming|due)$/;
const match=typeof p?.deliveryId==='string'?key.exec(p.deliveryId):null;
const valid=object&&Object.keys(p).sort().join(',')===keys.sort().join(',')&&JSON.stringify(p).length<=16000
&&p.version===1&&p.event==='subscription-renewal-reminder'&&match&&match[1]===p.nextRenewalOn&&match[4]===p.phase
&&typeof p.serviceName==='string'&&p.serviceName.trim()&&p.serviceName.length<=160
&&new Date(p.nextRenewalOn).toISOString().slice(0,10)===p.nextRenewalOn
&&typeof p.toRecipients==='string'&&p.toRecipients.length<=8192&&p.toRecipients.split(',').length<=32
&&p.toRecipients.split(',').every(e=>e.length<=254&&email.test(e)&&e===e.trim().toLowerCase())
&&[...new Set(p.toRecipients.split(','))].sort().join(',')===p.toRecipients;
if(!valid)return [{json:{valid:false,code:'invalid_payload'}}];
return [{json:{...p,valid:true,actualRecipient:p.toRecipients,ccRecipients:''}}];`;
  node('Send Subscription Email').webhookId = 'e5180000-0000-4000-8000-000000000002';
  node('Build Subscription Email').parameters.jsCode = `const c=$input.first().json;
const escape=v=>String(v??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const due=new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Melbourne',day:'numeric',month:'short',year:'numeric'}).format(new Date(c.nextRenewalOn+'T12:00:00Z'));
const status=c.phase==='upcoming'?'Upcoming renewal':'Renewal due';
const introduction=c.phase==='upcoming'?'A paid subscription is approaching its renewal date.':'A paid subscription is due for renewal.';
const bodyContent='<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.6;color:#22302b"><p>MAM subscription notification</p><p>'+introduction+'</p><p><strong>Subscription renewal details</strong></p><ul><li><strong>Subscription:</strong> '+escape(c.serviceName)+'</li><li><strong>Renewal date:</strong> '+escape(due)+'</li><li><strong>Status:</strong> '+escape(status)+'</li></ul><p>Please check the subscription renewal in People Hub Calendar.</p><p><a href="https://mam-team-management-system-ten.vercel.app/?view=calendar" style="display:inline-block;padding:10px 16px;background:#ef6c24;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">People Hub Calendar</a></p><p>Thanks,<br>People Hub</p>'+` + JSON.stringify(HR_EMAIL_SIGNATURE_HTML) + `+'</div>';
return [{json:{...c,subject:'[MAM] Subscription renewal '+(c.phase==='upcoming'?'upcoming: ':'due: ')+c.serviceName.replace(/[\\r\\n]/g,' ').slice(0,100),bodyContent}}];`;
  return workflow;
}
