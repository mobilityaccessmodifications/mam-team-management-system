import { buildSubscriptionRequestPennyMailWorkflow } from './build-subscription-request-penny-mail-workflow.mjs';
import { HR_EMAIL_SIGNATURE_HTML } from './hr-email-signature.mjs';

export function buildSubscriptionRequestTemplateMailWorkflow({ outlookCredential } = {}) {
  const workflow = buildSubscriptionRequestPennyMailWorkflow({ outlookCredential });
  workflow.name = 'MAM People Hub - Subscription Request Approval Email (Penny V3)';
  workflow.nodes.forEach(n => { n.id = n.id.replace('e5150000', 'e5170000'); });
  const node = name => workflow.nodes.find(n => n.name === name);
  node('Receive Subscription Request').parameters.path = 'mam-subscription-request-mail-v3';
  node('Receive Subscription Request').webhookId = 'e5170000-0000-4000-8000-000000000001';
  node('Validate Subscription Request').parameters.jsCode = `const p=$input.first().json.body;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).sort().join(',')===keys.sort().join(',');
const text=v=>typeof v==='string'&&v.length<=4000;
const email=/^[^\\s@,;]+@[^\\s@,;]+\\.[^\\s@,;]+$/;
const address=v=>typeof v==='string'&&v.length<=254&&email.test(v)&&v===v.trim().toLowerCase();
const cents=v=>v===null||(Number.isSafeInteger(v)&&v>=0&&v<=100000000);
const website=v=>{if(v===null)return true;if(!text(v)||v.length>2048||/[\\s\\x00-\\x1f\\x7f]/.test(v))return false;try{const u=new URL(v);return ['http:','https:'].includes(u.protocol)&&Boolean(u.hostname)&&!u.username&&!u.password;}catch{return false;}};
const key=/^subscription-request:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-9][0-9]*$/;
const fields=['service','plan','purpose','company','duration','billing','currency','quoteCents','audEstimateCents','noQuoteReason','intendedUsers','formVersion','monthlyCostCents','annualCostCents','comparisonUnavailableReason','payment','cardLabel','cardHolder','websiteUrl','category','usageFrequency','oneOffCostCents','invoiceEmail','invoiceContact'];
const r=p?.request;
const valid=exact(p,['version','event','deliveryId','applicantName','applicantWorkEmail','approverWorkEmail','request'])&&JSON.stringify(p).length<=48000
&&p.version===3&&p.event==='subscription-request-submitted'&&key.test(p.deliveryId)
&&text(p.applicantName)&&p.applicantName.trim()&&address(p.applicantWorkEmail)&&address(p.approverWorkEmail)
&&exact(r,fields)&&fields.filter(k=>!k.endsWith('Cents')&&k!=='formVersion').every(k=>r[k]===null||text(r[k]))
&&r.formVersion===3&&['quoteCents','audEstimateCents','monthlyCostCents','annualCostCents','oneOffCostCents'].every(k=>cents(r[k]))
&&text(r.service)&&r.service.trim()&&text(r.purpose)&&r.purpose.trim()&&text(r.intendedUsers)&&r.intendedUsers.trim()
&&['mam','equipsy','both'].includes(r.company)&&r.currency==='AUD'&&['ongoing','3_months','12_months'].includes(r.duration)
&&['software_app','hardware','subscription','one_off_service'].includes(r.category)&&website(r.websiteUrl)
&&['card','invoice','direct_debit'].includes(r.payment)
&&(r.payment!=='card'||(text(r.cardLabel)&&r.cardLabel.trim()&&text(r.cardHolder)&&r.cardHolder.trim()))
&&(r.invoiceEmail===null||address(r.invoiceEmail))&&(r.invoiceContact===null||(text(r.invoiceContact)&&r.invoiceContact.length<=160))
&&['monthly','annual','one_off'].includes(r.billing)&&r.quoteCents!==null&&r.audEstimateCents===r.quoteCents
&&(r.category!=='one_off_service'||r.billing==='one_off')
&&(r.billing==='one_off'?(r.oneOffCostCents!==null&&r.oneOffCostCents>0&&r.quoteCents===r.oneOffCostCents&&r.monthlyCostCents===null&&r.annualCostCents===null)
:(r.quoteCents===r[r.billing==='monthly'?'monthlyCostCents':'annualCostCents']&&((r.monthlyCostCents!==null&&r.annualCostCents!==null)||(text(r.comparisonUnavailableReason)&&r.comparisonUnavailableReason.trim()))));
if(!valid)return [{json:{valid:false,code:'invalid_payload'}}];
return [{json:{...p,valid:true,actualRecipient:p.approverWorkEmail,ccRecipients:p.applicantWorkEmail===p.approverWorkEmail?'':p.applicantWorkEmail}}];`;
  node('Send Subscription Email').webhookId = 'e5170000-0000-4000-8000-000000000002';
  node('Build Subscription Email').parameters.jsCode = `const c=$input.first().json;const r=c.request;
const escape=v=>String(v??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const row=(label,value)=>'<li><strong>'+label+':</strong> '+escape(value)+'</li>';
const money=cents=>cents===null?'Not provided':new Intl.NumberFormat('en-AU',{style:'currency',currency:'AUD'}).format(cents/100);
const details=[row('Requested by',c.applicantName),row('Company',{mam:'MAM',equipsy:'Equipsy',both:'MAM and Equipsy'}[r.company]),row('Service/Product',r.service),r.plan?row('Plan',r.plan):'',r.websiteUrl?row('Website',r.websiteUrl):'',row('Category',{software_app:'Software/App',hardware:'Hardware',subscription:'Subscription',one_off_service:'One-off service'}[r.category]),r.billing!=='one_off'?row('Monthly cost',money(r.monthlyCostCents)):'',r.billing!=='one_off'?row('Annual cost',money(r.annualCostCents)):'',r.comparisonUnavailableReason?row('Price comparison unavailable',r.comparisonUnavailableReason):'',r.billing!=='one_off'?row('Selected recurring cost',money(r.quoteCents)):'',r.oneOffCostCents!==null?row('One-off cost',money(r.oneOffCostCents)):'',row('Billing',{monthly:'Monthly',annual:'Annual',one_off:'One-off'}[r.billing]),row('Expected usage',{ongoing:'Ongoing','3_months':'3 months','12_months':'12 months'}[r.duration]),r.usageFrequency?row('Usage frequency',r.usageFrequency):'',row('Intended users',r.intendedUsers),row('Purpose',r.purpose),row('Payment method',{card:'Company credit card',invoice:'Invoice',direct_debit:'Direct debit'}[r.payment]),r.payment==='card'?row('Credit card',r.cardLabel):'',r.payment==='card'?row('Card holder',r.cardHolder):'',r.invoiceEmail?row('Invoice email',r.invoiceEmail):'',r.invoiceContact?row('Invoice contact',r.invoiceContact):'',row('Status','Awaiting approval')].join('');
const bodyContent='<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.6;color:#22302b"><p>MAM subscription notification</p><p>A subscription request has been submitted and is awaiting your approval.</p><p><strong>Subscription request details</strong></p><ul>'+details+'</ul><p>Please approve, return or reject the request in People Hub. The applicant has been copied into this notification.</p><p><a href="https://mam-team-management-system-ten.vercel.app/?view=people&amp;tab=tasks" style="display:inline-block;padding:10px 16px;background:#ef6c24;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">People Hub</a></p><p>Thanks,<br>People Hub</p>'+` + JSON.stringify(HR_EMAIL_SIGNATURE_HTML) + `+'</div>';
return [{json:{...c,subject:'[MAM] Subscription approval requested: '+c.applicantName.replace(/[\\r\\n]/g,' ').slice(0,80)+' — '+r.service.replace(/[\\r\\n]/g,' ').slice(0,100),bodyContent}}];`;
  return workflow;
}
