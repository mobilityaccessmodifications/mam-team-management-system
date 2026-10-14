import { buildSubscriptionRequestMailWorkflow } from './build-subscription-request-mail-workflow.mjs';
import { HR_EMAIL_SIGNATURE_HTML } from './hr-email-signature.mjs';

export function buildSubscriptionReviewMailWorkflow({ outlookCredential } = {}) {
  const workflow = buildSubscriptionRequestMailWorkflow({ outlookCredential, cronCredential: { id: 'unused', name: 'unused' } });
  workflow.name = 'MAM People Hub - Paid Subscription Review Reminders';
  workflow.nodes = workflow.nodes.filter(n => !['Retry queued submissions every five minutes', 'Dispatch queued subscription mail'].includes(n.name));
  delete workflow.connections['Retry queued submissions every five minutes'];
  const rename = value => value.replaceAll('Subscription Request', 'Subscription Review');
  workflow.nodes.forEach(n => { n.name = rename(n.name); if (n.parameters.jsCode) n.parameters.jsCode = rename(n.parameters.jsCode); });
  workflow.connections = Object.fromEntries(Object.entries(workflow.connections).map(([name, value]) => [
    rename(name), { main: value.main.map(branch => branch.map(edge => ({ ...edge, node: rename(edge.node) }))) },
  ]));
  const node = name => workflow.nodes.find(n => n.name === name);
  node('Receive Subscription Review').parameters.path = 'mam-subscription-review-mail-v1';
  node('Validate Subscription Review').parameters.jsCode = `const p=$input.first().json.body;
const keys=['version','event','deliveryId','serviceName','nextReviewOn','phase','toRecipients'];
const object=p&&typeof p==='object'&&!Array.isArray(p);
const email=/^[^\\s@,;]+@[^\\s@,;]+\\.[^\\s@,;]+$/;
const key=/^subscription-review:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])):(upcoming|due)$/;
const match=typeof p?.deliveryId==='string'?key.exec(p.deliveryId):null;
const valid=object&&Object.keys(p).sort().join(',')===keys.sort().join(',')&&JSON.stringify(p).length<=16000
&&p.version===1&&p.event==='subscription-review-reminder'&&match&&match[1]===p.nextReviewOn&&match[4]===p.phase
&&typeof p.serviceName==='string'&&p.serviceName.trim()&&p.serviceName.length<=160
&&new Date(p.nextReviewOn).toISOString().slice(0,10)===p.nextReviewOn
&&typeof p.toRecipients==='string'&&p.toRecipients.length<=8192&&p.toRecipients.split(',').length<=32
&&p.toRecipients.split(',').every(e=>e.length<=254&&email.test(e)&&e===e.trim().toLowerCase())
&&[...new Set(p.toRecipients.split(','))].sort().join(',')===p.toRecipients;
if(!valid)return [{json:{valid:false,code:'invalid_payload'}}];
return [{json:{...p,valid:true,actualRecipient:p.toRecipients,ccRecipients:''}}];`;
  node('Build Subscription Email').parameters.jsCode = `const c=$input.first().json;
const escape=v=>String(v??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const due=new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Melbourne',day:'numeric',month:'short',year:'numeric'}).format(new Date(c.nextReviewOn+'T12:00:00Z'));
const status=c.phase==='upcoming'?'Upcoming quarterly review':'Review due — not yet completed';
const bodyContent='<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.6;color:#22302b"><p>MAM subscription notification</p><p>A paid subscription is due for its quarterly review.</p><p><strong>Subscription review details</strong></p><ul><li><strong>Subscription:</strong> '+escape(c.serviceName)+'</li><li><strong>Review date:</strong> '+escape(due)+'</li><li><strong>Status:</strong> '+escape(status)+'</li></ul><p>Please review the subscription in People Hub and mark the review Done in Tasks.</p><p><a href="https://mam-team-management-system-ten.vercel.app/?view=people&amp;tab=tasks" style="display:inline-block;padding:10px 16px;background:#ef6c24;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">People Hub</a></p><p>Thanks,<br>People Hub</p>'+` + JSON.stringify(HR_EMAIL_SIGNATURE_HTML) + `+'</div>';
return [{json:{...c,subject:'[MAM] Paid subscription review '+(c.phase==='upcoming'?'upcoming: ':'due: ')+c.serviceName.replace(/[\\r\\n]/g,' ').slice(0,100),bodyContent}}];`;
  node('Send Subscription Email').parameters.toRecipients = '={{ $json.actualRecipient }}';
  return workflow;
}
