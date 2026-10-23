const closed = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Reflect.ownKeys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k) && Object.hasOwn(Object.getOwnPropertyDescriptor(v,k), 'value'));
const reject = () => [{json: {valid: false}}];
if ($input.all().length !== 1 || !Object.hasOwn($json, 'body')) return reject();
const p = $json.body;
if (!closed(p, ['version','event','eventKey','personId','recipient','employee','deliveryId','claimToken'])) return reject();
const e = p.employee;
if (!closed(e,['name','company','role','department','location','employmentType','startDate','endDate'])) return reject();
const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const text = v => typeof v === 'string' && v.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v);
const date = v => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v+'T12:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10) === v;
};
const addresses = typeof p.recipient === 'string' ? p.recipient.split(',') : [];
if (p.version !== 1 || !['onboarding','offboarding'].includes(p.event) || !uuid(p.personId) || !uuid(p.deliveryId) || !uuid(p.claimToken)
  || p.eventKey !== `employee-lifecycle:${p.deliveryId}:${p.event}` || addresses.length < 5 || addresses.length > 6
  || p.recipient !== [...new Set(addresses)].sort().join(',')
  || addresses.some(a => a !== a.trim().toLowerCase() || a.length > 254 || !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(a) || /[\u0000-\u001f\u007f]/.test(a))
  || ![e.name,e.company,e.role,e.department,e.location,e.employmentType].every(text) || !e.name.trim()
  || !['MAM','Equipsy'].includes(e.company) || !date(p.event === 'onboarding' ? e.startDate : e.endDate)
  || (e.startDate !== null && !date(e.startDate)) || (e.endDate !== null && !date(e.endDate))) return reject();
const mail = buildEmployeeLifecycleEmail({kind:p.event, employee:e});
return [{json: {valid: true, eventKey:p.eventKey, recipient:p.recipient, cc:'',
  reserveBody:{action:'reserve',eventKey:p.eventKey,recipient:p.recipient,cc:'',legacyEventKey:null,claimToken:p.claimToken},
  graphBody:{message:{subject:mail.subject,body:{contentType:'HTML',content:mail.html},
    from:{emailAddress:{address:'ai@mobilityaccess.com.au'}},replyTo:[{emailAddress:{address:'careers@mobilityaccess.com.au'}}],
    toRecipients:addresses.map(address=>({emailAddress:{address}})),ccRecipients:[],bccRecipients:[]},saveToSentItems:true}}}];
