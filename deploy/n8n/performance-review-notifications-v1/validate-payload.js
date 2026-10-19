const closed = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const reject = () => [{json: {valid: false}}];
if ($input.all().length !== 1) return reject();
const descriptor = Object.getOwnPropertyDescriptor($json, 'body');
if (!descriptor || !Object.hasOwn(descriptor, 'value')) return reject();
const p = descriptor.value;
if (!closed(p, ['version','event','eventKey','reviewId','reviewCode','cycle','dueDate','recipient','employeeName','managerName','claimToken'])) return reject();
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const control = /[\u0000-\u001f\u007f\ufffe\uffff]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const name = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 8000
  && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/.test(value);
const date = value => {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
if (p.version !== 1 || !['started','self-submitted'].includes(p.event) || !uuid(p.reviewId) || !uuid(p.claimToken)
  || p.eventKey !== `performance-review:${p.reviewId}:${p.event}`
  || typeof p.cycle !== 'string' || !/^[0-9]{4}$/.test(p.cycle)
  || typeof p.reviewCode !== 'string' || p.reviewCode.length > 64 || !/^PR-[0-9]{4}-[1-9][0-9]*$/.test(p.reviewCode)
  || !p.reviewCode.startsWith(`PR-${p.cycle}-`) || !date(p.dueDate) || !name(p.employeeName) || !name(p.managerName)
  || typeof p.recipient !== 'string' || p.recipient.length > 254 || control.test(p.recipient)
  || p.recipient !== p.recipient.trim().toLowerCase() || !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(p.recipient)) return reject();
const link = 'https://mam-team-management-system-ten.vercel.app/?view=people&tab=performance';
const content = p.event === 'started'
  ? `Hi ${p.employeeName},\n\n${p.managerName} has started your ${p.cycle} performance review (${p.reviewCode}). Please complete and submit your self-assessment in People Hub by ${p.dueDate}.\n\n${link}\n\nThanks,\nPeople Hub`
  : `Hi ${p.managerName},\n\n${p.employeeName} has submitted their self-assessment for ${p.reviewCode}. Please complete your manager assessment in People Hub and arrange the review meeting with ${p.employeeName}.\n\nReview due date: ${p.dueDate}\n\n${link}\n\nThanks,\nPeople Hub`;
return [{json: {valid: true, eventKey: p.eventKey, recipient: p.recipient,
  reserveBody: {action: 'reserve', eventKey: p.eventKey, recipient: p.recipient, cc: '', legacyEventKey: null, claimToken: p.claimToken},
  graphBody: {message: {
    subject: p.event === 'started' ? `Performance review started — ${p.reviewCode}` : `Self-assessment submitted — ${p.reviewCode}`,
    body: {contentType: 'Text', content}, toRecipients: [{emailAddress: {address: p.recipient}}], ccRecipients: [], bccRecipients: [],
  }, saveToSentItems: true}}}];
