const closed = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const reject = () => [{json: {valid: false}}];
if ($input.all().length !== 1) return reject();
const descriptor = Object.getOwnPropertyDescriptor($json, 'body');
if (!descriptor || !Object.hasOwn(descriptor, 'value')) return reject();
const p = descriptor.value;
const hasCc = p !== null && typeof p === 'object' && Object.hasOwn(p, 'cc');
if (!closed(p, ['version','event','eventKey','reviewId','reviewCode','cycle','dueDate','recipient','employeeName','managerName','claimToken',...(hasCc ? ['cc'] : [])])) return reject();
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const control = /[\u0000-\u001f\u007f\ufffe\uffff]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const name = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 8000
  && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/.test(value);
const date = value => {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const recipients = typeof p.recipient === 'string' ? p.recipient.split(',') : [];
if (p.version !== 1 || !['started','self-submitted','manager-invited'].includes(p.event) || !uuid(p.reviewId) || !uuid(p.claimToken)
  || p.eventKey !== `performance-review:${p.reviewId}:${p.event}`
  || typeof p.cycle !== 'string' || !/^[0-9]{4}$/.test(p.cycle)
  || typeof p.reviewCode !== 'string' || p.reviewCode.length > 64 || !/^PR-[0-9]{4}-[1-9][0-9]*$/.test(p.reviewCode)
  || !p.reviewCode.startsWith(`PR-${p.cycle}-`) || !date(p.dueDate) || !name(p.employeeName) || !name(p.managerName)
  || typeof p.recipient !== 'string' || recipients.length !== (p.event === 'manager-invited' ? 2 : 1)
  || p.recipient !== [...new Set(recipients)].sort().join(',')
  || recipients.some(value => value.length > 254 || control.test(value) || value !== value.trim().toLowerCase() || !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(value))) return reject();
const cc = hasCc ? p.cc : '';
const expectedCc = p.event === 'manager-invited' || recipients.includes('careers@mobilityaccess.com.au') ? '' : 'careers@mobilityaccess.com.au';
if (((hasCc || p.event === 'manager-invited') && cc !== expectedCc)
  || (p.event === 'manager-invited' && (!hasCc || recipients.includes('careers@mobilityaccess.com.au')))) return reject();
const link = 'https://mam-team-management-system-ten.vercel.app/?view=people&tab=performance';
const signature = '<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:24px;border-top:1px solid #dce4df;padding-top:16px;font-family:Segoe UI,Arial,sans-serif"><tr><td style="vertical-align:middle;padding-right:16px"><a href="https://www.mobilityaccess.com.au/" style="text-decoration:none"><img src="https://mam-team-management-system-ten.vercel.app/email/mam-logo.jpg" alt="MAM – Mobility Access Modifications" width="150" height="69" style="display:block;width:150px;height:auto;border:0"></a></td><td style="vertical-align:middle;color:#50615b;font-size:12px;line-height:1.5"><strong style="color:#22302b;font-size:13px">People &amp; Culture</strong><br>Mobility Access Modifications</td></tr></table>';
const message = p.event === 'started'
  ? 'Your performance review is ready. Please complete your self-assessment in People Hub.'
  : p.event === 'self-submitted'
    ? 'A self-assessment has been submitted. Please open People Hub to complete the next step.'
    : `The manager assessment has been saved. Please use Reply with Meeting in Outlook to arrange the review with the employee. Include ai@mobilityaccess.com.au and the employee as attendees, and keep ${p.reviewCode} in the subject.`;
const content = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.6;color:#22302b"><p>Hi,</p><p>${message}</p><p><a href="${link}" style="color:#c84d0e">Open People Hub</a></p><p>Thanks,<br>People Hub</p>${signature}</div>`;
return [{json: {valid: true, eventKey: p.eventKey, recipient: p.recipient, cc,
  reserveBody: {action: 'reserve', eventKey: p.eventKey, recipient: p.recipient, cc, legacyEventKey: null, claimToken: p.claimToken},
  graphBody: {message: {
    subject: p.event === 'started' ? 'Your performance review is ready' : p.event === 'self-submitted' ? 'Self-assessment submitted' : `Arrange performance review: ${p.reviewCode}`,
    body: {contentType: 'HTML', content}, toRecipients: recipients.map(address => ({emailAddress: {address}})), ccRecipients: cc ? [{emailAddress: {address: cc}}] : [], bccRecipients: [],
  }, saveToSentItems: true}}}];
