const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const closed = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const held = {ok: false, status: 'held', deliveryId: null, eventKey: null, actualRecipients: ['careers@mobilityaccess.com.au'], attachmentSha256: null};
const reject = () => [{json: {valid: false, response: held}}];
const items = $input.all();
if (items.length !== 1) return reject();
const descriptor = Object.getOwnPropertyDescriptor($json, 'body');
if (!descriptor || !Object.hasOwn(descriptor, 'value')) return reject();
const p = descriptor.value;
const keys = ['version','event','eventKey','deliveryId','reviewId','reviewCode','claimToken','employeeName','managerName','finalisedAt','recipient','managerNote','attachment'];
if (!closed(p, keys)) return reject();
const text = (value, max, nonempty = false) => typeof value === 'string' && value.length <= max && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/.test(value) && (!nonempty || value.trim().length > 0);
const name = value => text(value, 240, true) && Array.from(value).length <= 120;
const date = value => {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
};
if (p.version !== 1 || p.event !== 'performance-review-finalised' || !uuid(p.deliveryId) || !uuid(p.reviewId) || !uuid(p.claimToken)
  || p.eventKey !== `performance-review:${p.reviewId}:finalised` || p.recipient !== 'careers@mobilityaccess.com.au'
  || typeof p.reviewCode !== 'string' || p.reviewCode.length > 64 || !/^PR-\d{4}-\d+$/.test(p.reviewCode)
  || !name(p.employeeName) || !name(p.managerName) || !text(p.managerNote, 8000, true) || !date(p.finalisedAt)) return reject();
const a = p.attachment;
if (!closed(a, ['fileName','mimeType','contentBase64','sha256']) || a.fileName !== `${p.reviewCode}-manager.docx`
  || a.mimeType !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  || typeof a.contentBase64 !== 'string' || a.contentBase64.length === 0 || a.contentBase64.length > 2796204
  || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(a.contentBase64)
  || typeof a.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.sha256)) return reject();
const bytes = Buffer.from(a.contentBase64, 'base64');
if (bytes.length === 0 || bytes.length > 2097152 || bytes.toString('base64') !== a.contentBase64
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  || require('crypto').createHash('sha256').update(bytes).digest('hex') !== a.sha256) return reject();
held.deliveryId = p.deliveryId; held.eventKey = p.eventKey; held.attachmentSha256 = a.sha256;
const escape = value => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])).replace(/\r\n?/g, '\n').replace(/\n/g, '<br>');
const graphBody = {
  message: {
    subject: `Performance review finalised — ${p.reviewCode}`,
    body: {contentType: 'HTML', content: `<p>Performance review ${escape(p.reviewCode)}</p><p>Employee: ${escape(p.employeeName)}<br>Manager: ${escape(p.managerName)}<br>Finalised: ${escape(p.finalisedAt)}</p><p>Manager note:<br>${escape(p.managerNote)}</p>`},
    toRecipients: [{emailAddress: {address: 'careers@mobilityaccess.com.au'}}], ccRecipients: [], bccRecipients: [],
    attachments: [{'@odata.type': '#microsoft.graph.fileAttachment', name: p.attachment.fileName, contentType: p.attachment.mimeType, contentBytes: p.attachment.contentBase64}],
  },
  saveToSentItems: true,
};
const beginBody = {phase: 'begin', deliveryId: p.deliveryId, claimToken: p.claimToken, attachmentSha256: p.attachment.sha256};
const binding = {deliveryId: p.deliveryId, eventKey: p.eventKey, actualRecipients: ['careers@mobilityaccess.com.au'], attachmentSha256: p.attachment.sha256};
return [{json: {valid: true, binding, beginBody, graphBody}}];
