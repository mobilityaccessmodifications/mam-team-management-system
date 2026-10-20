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
if (bytes.length === 0 || bytes.length > 2097152 || bytes.toString('base64') !== a.contentBase64) return reject();
const sha256 = input => {
  const constants = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ];
  const state = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const padded = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  padded.set(input); padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, input.length * 8);
  const words = new Int32Array(64);
  const rotate = (word, bits) => (word >>> bits) | (word << (32 - bits));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getInt32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15], y = words[i - 2];
      words[i] = words[i - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3))
        + words[i - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10));
    }
    let [a,b,c,d,e,f,g,h] = state;
    for (let i = 0; i < 64; i++) {
      const first = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25))
        + ((e & f) ^ (~e & g)) + constants[i] + words[i]) | 0;
      const second = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + first) | 0; d = c; c = b; b = a; a = (first + second) | 0;
    }
    for (const [i, value] of [a,b,c,d,e,f,g,h].entries()) state[i] = (state[i] + value) | 0;
  }
  return state.map(value => (value >>> 0).toString(16).padStart(8, '0')).join('');
};
if (sha256(bytes) !== a.sha256) return reject();
held.deliveryId = p.deliveryId; held.eventKey = p.eventKey; held.attachmentSha256 = a.sha256;
const escape = value => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])).replace(/\r\n?/g, '\n').replace(/\n/g, '<br>');
const signature = '<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:24px;border-top:1px solid #dce4df;padding-top:16px;font-family:Segoe UI,Arial,sans-serif"><tr><td style="vertical-align:middle;padding-right:16px"><a href="https://www.mobilityaccess.com.au/" style="text-decoration:none"><img src="https://mam-team-management-system-ten.vercel.app/email/mam-logo.jpg" alt="MAM – Mobility Access Modifications" width="150" height="69" style="display:block;width:150px;height:auto;border:0"></a></td><td style="vertical-align:middle;color:#50615b;font-size:12px;line-height:1.5"><strong style="color:#22302b;font-size:13px">People &amp; Culture</strong><br>Mobility Access Modifications</td></tr></table>';
const graphBody = {
  message: {
    subject: 'Performance review completed',
    body: {contentType: 'HTML', content: `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.6;color:#22302b"><p>Hi team,</p><p>A performance review is complete. The completed document is attached.</p><p>Manager note:<br>${escape(p.managerNote)}</p><p>Thanks,<br>People Hub</p>${signature}</div>`},
    toRecipients: [{emailAddress: {address: 'careers@mobilityaccess.com.au'}}], ccRecipients: [], bccRecipients: [],
    attachments: [{'@odata.type': '#microsoft.graph.fileAttachment', name: p.attachment.fileName, contentType: p.attachment.mimeType, contentBytes: p.attachment.contentBase64}],
  },
  saveToSentItems: true,
};
const beginBody = {phase: 'begin', deliveryId: p.deliveryId, claimToken: p.claimToken, attachmentSha256: p.attachment.sha256};
const binding = {deliveryId: p.deliveryId, eventKey: p.eventKey, actualRecipients: ['careers@mobilityaccess.com.au'], attachmentSha256: p.attachment.sha256};
return [{json: {valid: true, binding, beginBody, graphBody}}];
