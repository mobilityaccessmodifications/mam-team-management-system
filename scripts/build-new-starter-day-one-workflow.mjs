import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TEST_RECIPIENT = 'marketing@mobilityaccess.com.au';
export const CHECKLIST_PATH = path.join(ROOT, 'assets/checklists/Day 1 New Starter Readiness Checklist.docx');
const RECEIPT_URL = 'https://mam-team-management-system-ten.vercel.app/api/internal/integrations/notifications/receipts';
const HR_OUTLOOK_CREDENTIAL = { id: 'vFEolsXoEOOxNyan', name: 'Microsoft Outlook account - hr@mobilityaccess.com.au' };
const RECEIPT_CREDENTIAL = { id: 'tGtpwegru8OxtdCt', name: 'MAM Team Management - Notification Webhook Header' };

const node = (id, name, type, typeVersion, position, parameters, extra = {}) => ({
  id, name, type, typeVersion, position, parameters, ...extra,
});

function validatorCode(mode) {
  return `const payload = $input.first().json.body ?? $input.first().json;
const MODE = ${JSON.stringify(mode)};
const TEST_RECIPIENT = ${JSON.stringify(TEST_RECIPIENT)};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const email = /^[^\\s@,;]+@[^\\s@,;]+\\.[^\\s@,;]+$/;
const clean = value => typeof value === 'string' ? value.trim() : '';
const normalEmail = value => { const result = clean(value).toLowerCase(); return email.test(result) && result.length <= 254 ? result : ''; };
const employee = payload && typeof payload.employee === 'object' && payload.employee ? payload.employee : {};
const manager = payload && typeof payload.manager === 'object' && payload.manager ? payload.manager : {};
const reminderId = typeof payload?.deliveryId === 'string' ? payload.deliveryId.split(':')[1] : '';
const expectedId = reminderId && uuid.test(reminderId) ? \`new-starter:\${reminderId}:day-one:\${MODE}\` : '';
const workEmail = normalEmail(employee.workEmail);
const personalEmail = normalEmail(employee.personalEmail);
const managerEmail = normalEmail(manager.email);
const employeeRecipients = [...new Set([workEmail, personalEmail].filter(Boolean))].sort();
const liveRecipients = [...new Set([...employeeRecipients, managerEmail].filter(Boolean))].sort();
const valid = payload?.version === 1 && payload?.event === 'new-starter-day-one' && payload?.mode === MODE
  && payload?.deliveryId === expectedId && clean(employee.firstName) && clean(employee.role)
  && (employee.company === 'mam' || employee.company === 'equipsy') && employeeRecipients.length > 0
  && clean(manager.firstName) && managerEmail && /^\\d{4}-\\d{2}-\\d{2}$/.test(clean(payload.commencementDate));
if (!valid) return [{ json: { valid: false, deliveryId: expectedId || 'invalid', code: 'invalid_payload' } }];
return [{ json: {
  valid: true, deliveryId: expectedId,
  actualRecipient: MODE === 'test' ? TEST_RECIPIENT : liveRecipients.join(','), ccRecipients: '',
  employeeFirstName: clean(employee.firstName), managerFirstName: clean(manager.firstName),
  role: clean(employee.role), companyName: employee.company === 'mam' ? 'MAM' : 'Equipsy',
  commencementDate: clean(payload.commencementDate),
} }];`;
}

const gateCode = `const context = $('Validate Day 1 Request').first().json;
const reservation = $input.first().json;
if (reservation?.outcome === 'send' && /^[0-9a-f-]{36}$/i.test(reservation.deliveryToken || '')) {
  return [{ json: { ...context, shouldSend: true, alreadySent: false, deliveryToken: reservation.deliveryToken } }];
}
if (reservation?.outcome === 'duplicate' && reservation?.ok === true && reservation?.alreadySent === true) {
  return [{ json: { ...context, shouldSend: false, alreadySent: true } }];
}
return [{ json: { ...context, shouldSend: false, alreadySent: false, code: reservation?.rejectionCode || 'reservation_rejected' } }];`;

function emailCode(checklistBase64) {
  return `const source = $input.first().json;
const escapeHtml = value => String(value).replace(/[&<>\"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[char]));
const employee = escapeHtml(source.employeeFirstName);
const manager = escapeHtml(source.managerFirstName);
const role = escapeHtml(source.role);
const bodyContent = \`<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.6;color:#22302b"><p>Hi \${employee} and \${manager},</p><p>We’re looking forward to \${employee} joining us as our new <strong>\${role}</strong>.</p><p>On the first day, you’ll spend some time together making sure everything is ready for a safe and organised start.</p><p>This will include your role and reporting line, first-week expectations, workplace induction, systems and equipment access, safety requirements, PPE where applicable, and who to go to when you need help.</p><p>\${manager}, please use the attached <strong>Day 1 New Starter Readiness Checklist</strong> to make sure everything has been covered and complete it by the end of \${employee}’s first day.</p><p>Welcome to the team, \${employee}!</p><p>Thanks,<br>HR Manager</p></div>\`;
return [{ json: { ...source, subject: 'Welcome to MAM/Equipsy – Your First Day', bodyContent }, binary: {
  checklist: { data: ${JSON.stringify(checklistBase64)}, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileName: 'Day 1 New Starter Readiness Checklist.docx' }
} }];`;
}

const confirmationCode = `const context = $('Build Day 1 Email and Attachment').first().json;
const provider = $input.first().json;
const messageId = typeof provider?.id === 'string' && provider.id ? provider.id : null;
return [{ json: {
  action: 'confirm', eventKey: context.deliveryId, recipient: context.actualRecipient, cc: '',
  deliveryToken: context.deliveryToken,
  providerReceipt: { accepted: true, messageId, requestId: null, statusCode: 202 }
} }];`;

const validateConfirmationCode = `const context = $('Build Day 1 Email and Attachment').first().json;
const receipt = $input.first().json;
const accepted = receipt?.ok === true && receipt?.sent === true && receipt?.alreadySent === false
  && receipt?.eventKey === context.deliveryId && receipt?.actualRecipient === context.actualRecipient
  && receipt?.actualCcRecipients === '';
return [{ json: accepted
  ? { ok: true, sent: true, alreadySent: false, deliveryId: context.deliveryId }
  : { ok: false, sent: false, alreadySent: false, deliveryId: context.deliveryId, code: 'confirmation_rejected' } }];`;

export function buildNewStarterDayOneWorkflow({
  mode = 'test',
  webhookCredential = { id: 'b5WWH2Mm2r1QTCHp', name: 'MAM People System - Check-In Reminder Webhook Header v2' },
} = {}) {
  if (!['test', 'live'].includes(mode)) throw new Error('Workflow mode must be test or live.');
  const checklistBase64 = readFileSync(CHECKLIST_PATH).toString('base64');
  const nodes = [
    node('d1000000-0000-4000-8000-000000000001', 'Receive Day 1 Request', 'n8n-nodes-base.webhook', 2.1, [-960, 0], {
      authentication: 'headerAuth', httpMethod: 'POST', path: `mam-people-hub-new-starter-day-one-${mode}-v1`, responseMode: 'lastNode', options: {},
    }, { webhookId: 'd1000000-0000-4000-8000-000000000001', credentials: { httpHeaderAuth: webhookCredential } }),
    node('d1000000-0000-4000-8000-000000000002', 'Validate Day 1 Request', 'n8n-nodes-base.code', 2, [-740, 0], {
      mode: 'runOnceForAllItems', jsCode: validatorCode(mode),
    }),
    node('d1000000-0000-4000-8000-000000000003', 'Valid Day 1 Request?', 'n8n-nodes-base.if', 2.2, [-520, 0], {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ id: 'd1000000-0000-4000-8000-000000000103', leftValue: '={{ $json.valid }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {},
    }),
    node('d1000000-0000-4000-8000-000000000004', 'Reserve Durable Day 1 Delivery', 'n8n-nodes-base.httpRequest', 4.2, [-280, -80], {
      method: 'POST', url: RECEIPT_URL, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
      sendBody: true, contentType: 'json', specifyBody: 'json',
      jsonBody: "={{ { action: 'reserve', eventKey: $json.deliveryId, recipient: $json.actualRecipient, cc: '', legacyEventKey: null } }}",
      options: { redirect: { redirect: { followRedirects: false } }, timeout: 10000,
        response: { response: { responseFormat: 'json', neverError: false, fullResponse: false } } },
    }, { credentials: { httpHeaderAuth: RECEIPT_CREDENTIAL } }),
    node('d1000000-0000-4000-8000-000000000005', 'Gate Durable Day 1 Reservation', 'n8n-nodes-base.code', 2, [-40, -80], { jsCode: gateCode }),
    node('d1000000-0000-4000-8000-000000000006', 'Send Day 1 Email?', 'n8n-nodes-base.if', 2.2, [180, -80], {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ id: 'd1000000-0000-4000-8000-000000000106', leftValue: '={{ $json.shouldSend }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {},
    }),
    node('d1000000-0000-4000-8000-000000000007', 'Build Day 1 Email and Attachment', 'n8n-nodes-base.code', 2, [420, -180], {
      mode: 'runOnceForAllItems', jsCode: emailCode(checklistBase64),
    }),
    node('d1000000-0000-4000-8000-000000000008', 'Send Day 1 Email from HR', 'n8n-nodes-base.microsoftOutlook', 2, [660, -180], {
      resource: 'message', operation: 'send', toRecipients: '={{ $json.actualRecipient }}', subject: '={{ $json.subject }}', bodyContent: '={{ $json.bodyContent }}',
      additionalFields: { bodyContentType: 'html', saveToSentItems: true,
        attachments: { attachments: [{ binaryPropertyName: 'checklist' }] } },
    }, { credentials: { microsoftOutlookOAuth2Api: HR_OUTLOOK_CREDENTIAL } }),
    node('d1000000-0000-4000-8000-000000000009', 'Build Durable Day 1 Confirmation', 'n8n-nodes-base.code', 2, [900, -180], {
      mode: 'runOnceForAllItems', jsCode: confirmationCode,
    }),
    node('d1000000-0000-4000-8000-000000000010', 'Confirm Durable Day 1 Delivery', 'n8n-nodes-base.httpRequest', 4.2, [1140, -180], {
      method: 'POST', url: RECEIPT_URL, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
      sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: '={{ $json }}',
      options: { redirect: { redirect: { followRedirects: false } }, timeout: 10000,
        response: { response: { responseFormat: 'json', neverError: false, fullResponse: false } } },
    }, { credentials: { httpHeaderAuth: RECEIPT_CREDENTIAL } }),
    node('d1000000-0000-4000-8000-000000000011', 'Validate Durable Day 1 Confirmation', 'n8n-nodes-base.code', 2, [1380, -180], {
      mode: 'runOnceForAllItems', jsCode: validateConfirmationCode,
    }),
    node('d1000000-0000-4000-8000-000000000012', 'Already Delivered?', 'n8n-nodes-base.if', 2.2, [420, 40], {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ id: 'd1000000-0000-4000-8000-000000000112', leftValue: '={{ $json.alreadySent }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {},
    }),
    node('d1000000-0000-4000-8000-000000000013', 'Return Day 1 Duplicate', 'n8n-nodes-base.code', 2, [660, 0], {
      jsCode: "return [{ json: { ok: true, sent: false, alreadySent: true, deliveryId: $json.deliveryId } }];",
    }),
    node('d1000000-0000-4000-8000-000000000014', 'Return Day 1 Rejection', 'n8n-nodes-base.code', 2, [660, 100], {
      jsCode: "return [{ json: { ok: false, sent: false, alreadySent: false, deliveryId: $json.deliveryId || 'invalid', code: $json.code || 'rejected' } }];",
    }),
  ];
  const connections = {
    'Receive Day 1 Request': { main: [[{ node: 'Validate Day 1 Request', type: 'main', index: 0 }]] },
    'Validate Day 1 Request': { main: [[{ node: 'Valid Day 1 Request?', type: 'main', index: 0 }]] },
    'Valid Day 1 Request?': { main: [[{ node: 'Reserve Durable Day 1 Delivery', type: 'main', index: 0 }], [{ node: 'Return Day 1 Rejection', type: 'main', index: 0 }]] },
    'Reserve Durable Day 1 Delivery': { main: [[{ node: 'Gate Durable Day 1 Reservation', type: 'main', index: 0 }]] },
    'Gate Durable Day 1 Reservation': { main: [[{ node: 'Send Day 1 Email?', type: 'main', index: 0 }]] },
    'Send Day 1 Email?': { main: [[{ node: 'Build Day 1 Email and Attachment', type: 'main', index: 0 }], [{ node: 'Already Delivered?', type: 'main', index: 0 }]] },
    'Build Day 1 Email and Attachment': { main: [[{ node: 'Send Day 1 Email from HR', type: 'main', index: 0 }]] },
    'Send Day 1 Email from HR': { main: [[{ node: 'Build Durable Day 1 Confirmation', type: 'main', index: 0 }]] },
    'Build Durable Day 1 Confirmation': { main: [[{ node: 'Confirm Durable Day 1 Delivery', type: 'main', index: 0 }]] },
    'Confirm Durable Day 1 Delivery': { main: [[{ node: 'Validate Durable Day 1 Confirmation', type: 'main', index: 0 }]] },
    'Already Delivered?': { main: [[{ node: 'Return Day 1 Duplicate', type: 'main', index: 0 }], [{ node: 'Return Day 1 Rejection', type: 'main', index: 0 }]] },
  };
  return {
    name: `MAM People Hub - Day 1 New Starter Email (${mode === 'test' ? 'Marketing Test' : 'Live'})`, nodes, connections,
    settings: { executionOrder: 'v1', timezone: 'Australia/Melbourne', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all', saveExecutionProgress: false },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  const mode = process.argv[3] ?? 'test';
  if (!output) throw new Error('Usage: node scripts/build-new-starter-day-one-workflow.mjs <output.json> [test|live]');
  writeFileSync(output, JSON.stringify(buildNewStarterDayOneWorkflow({ mode }), null, 2) + '\n', { mode: 0o600 });
}
