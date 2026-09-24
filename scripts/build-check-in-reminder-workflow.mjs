import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TEST_RECIPIENT = 'marketing@mobilityaccess.com.au';
export const TWO_WEEK_RECORD_PATH = path.join(ROOT, 'assets/checklists/2 Week New Starter Check-In Record.docx');
export const ONE_MONTH_RECORD_PATH = path.join(ROOT, 'assets/checklists/1 Month New Starter Check-In Record.docx');
export const TWO_MONTH_RECORD_PATH = path.join(ROOT, 'assets/checklists/2 Month Stay Interview Record.docx');
export const THREE_MONTH_RECORD_PATH = path.join(ROOT, 'assets/checklists/3 Month Midpoint Probation Review.docx');
export const FIVE_MONTH_RECORD_PATH = path.join(ROOT, 'assets/checklists/5-Month No-Surprises Review.docx');
export const SIX_MONTH_RECORD_PATH = path.join(ROOT, 'assets/checklists/6 Month Check-In Record - Permanent and Fixed-Term.docx');
const RECEIPT_URL = 'https://mam-team-management-system-ten.vercel.app/api/internal/integrations/notifications/receipts';
const HR_OUTLOOK_CREDENTIAL = { id: 'vFEolsXoEOOxNyan', name: 'Microsoft Outlook account - hr@mobilityaccess.com.au' };
const RECEIPT_CREDENTIAL = { id: 'tGtpwegru8OxtdCt', name: 'MAM Team Management - Notification Webhook Header' };
const PEOPLE_CULTURE_RECIPIENT = 'hr@mobilityaccess.com.au';

const node = (id, name, type, typeVersion, position, parameters, extra = {}) => ({
  id, name, type, typeVersion, position, parameters, ...extra,
});

function validatorCode(mode) {
  return `const payload = $input.first().json.body ?? $input.first().json;
const MODE = ${JSON.stringify(mode)};
const TEST_RECIPIENT = ${JSON.stringify(TEST_RECIPIENT)};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const email = /^[^\\s@,;]+@[^\\s@,;]+\\.[^\\s@,;]+$/;
const unsafeControl = /[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]/;
const unsafeHeaderControl = /[\\u0000-\\u001f\\u007f]/;
const clean = value => typeof value === 'string' ? value.trim() : '';
const normalEmail = value => { const result = clean(value).toLowerCase(); return email.test(result) && result.length <= 254 ? result : ''; };
const event = clean(payload?.event);
if (event === 'checkin-review-escalation') {
  const reviewVersion = Number(payload?.reviewVersion);
  const match = typeof payload?.deliveryId === 'string'
    ? payload.deliveryId.match(/^checkin-review:([0-9a-f-]{36}):hr:([1-9][0-9]*):(test|live)$/i)
    : null;
  const expectedId = match && uuid.test(match[1]) && Number(match[2]) === reviewVersion && match[3] === MODE
    ? payload.deliveryId
    : '';
  const employeeName = clean(payload?.employeeName);
  const managerName = clean(payload?.managerName);
  const milestone = clean(payload?.milestone);
  const reviewDate = clean(payload?.reviewDate);
  const notes = clean(payload?.notes);
  const valid = payload?.version === 1 && payload?.mode === MODE && expectedId
    && employeeName && employeeName.length <= 160 && !unsafeHeaderControl.test(employeeName)
    && managerName && managerName.length <= 160 && !unsafeControl.test(managerName)
    && ['2-week','1-month','2-month','3-month','5-month','6-month'].includes(milestone)
    && /^\\d{4}-\\d{2}-\\d{2}$/.test(reviewDate)
    && notes && notes.length <= 2000 && !unsafeControl.test(notes);
  if (!valid) return [{ json: { valid: false, kind: 'review-escalation', deliveryId: expectedId || 'invalid', code: 'invalid_payload' } }];
  return [{ json: {
    valid: true, kind: 'review-escalation', deliveryId: expectedId,
    actualRecipient: MODE === 'test' ? TEST_RECIPIENT : ${JSON.stringify(PEOPLE_CULTURE_RECIPIENT)}, ccRecipients: '',
    deliveryTo: MODE === 'test' ? TEST_RECIPIENT : ${JSON.stringify(PEOPLE_CULTURE_RECIPIENT)}, deliveryBcc: '',
    employeeName, managerName, milestone, reviewDate, notes, reviewVersion,
  } }];
}
const employee = payload && typeof payload.employee === 'object' && payload.employee ? payload.employee : {};
const manager = payload && typeof payload.manager === 'object' && payload.manager ? payload.manager : {};
const managerEmail = normalEmail(manager.email);
const employeeWorkEmail = normalEmail(employee.workEmail);
const employeePersonalEmail = normalEmail(employee.personalEmail);
const employeeRecipients = [...new Set([employeeWorkEmail, employeePersonalEmail].filter(Boolean))].sort();
const milestone = clean(payload?.milestone);
const reminder = clean(payload?.reminder);
const reminderId = typeof payload?.deliveryId === 'string' ? payload.deliveryId.split(':')[1] : '';
const expectedId = reminderId && uuid.test(reminderId) ? \`checkin:\${reminderId}:\${milestone}:\${reminder}:\${MODE}\` : '';
const liveRecipients = ['2-week','1-month','2-month','3-month','5-month','6-month'].includes(milestone)
  ? [...new Set([...employeeRecipients, managerEmail].filter(Boolean))].sort()
  : [managerEmail].filter(Boolean);
const visibleRecipients = [...new Set([employeeWorkEmail, managerEmail].filter(Boolean))].sort();
const blindRecipients = employeePersonalEmail && !visibleRecipients.includes(employeePersonalEmail)
  ? [employeePersonalEmail]
  : [];
const employeeFirstName = clean(employee.firstName);
const employeeLastName = clean(employee.lastName);
const employeeRole = clean(employee.role);
const employeeDepartment = clean(employee.department);
const managerName = clean(manager.name);
const valid = payload?.version === 1 && event === 'checkin-reminder' && payload?.mode === MODE
  && payload?.deliveryId === expectedId
  && [employeeFirstName, employeeLastName, employeeRole, employeeDepartment, managerName]
    .every(value => value && value.length <= 160 && !unsafeHeaderControl.test(value))
  && managerEmail
  && ['2-week','1-month','2-month','3-month','5-month','6-month'].includes(milestone)
  && reminder === 'initial'
  && /^\\d{4}-\\d{2}-\\d{2}$/.test(clean(payload?.dueDate))
  && employeeRecipients.length > 0;
if (!valid) return [{ json: { valid: false, deliveryId: expectedId || 'invalid', code: 'invalid_payload' } }];
const managerFirstName = managerName.split(/\\s+/)[0];
return [{ json: {
  valid: true, kind: 'reminder', deliveryId: expectedId, milestone, reminder,
  actualRecipient: MODE === 'test' ? TEST_RECIPIENT : liveRecipients.join(','), ccRecipients: '',
  deliveryTo: MODE === 'test' ? TEST_RECIPIENT : visibleRecipients.join(','),
  deliveryBcc: MODE === 'test' ? '' : blindRecipients.join(','),
  employeeFirstName, employeeName: \`\${employeeFirstName} \${employeeLastName}\`,
  managerFirstName, managerName, role: employeeRole, department: employeeDepartment,
  dueDate: clean(payload.dueDate), resources: payload.resources,
} }];`;
}

const gateCode = `const context = $('Validate Check-In Request').first().json;
const reservation = $input.first().json;
if (reservation?.outcome === 'send' && /^[0-9a-f-]{36}$/i.test(reservation.deliveryToken || '')) {
  return [{ json: { ...context, shouldSend: true, alreadySent: false, deliveryToken: reservation.deliveryToken } }];
}
if (reservation?.outcome === 'duplicate' && reservation?.ok === true && reservation?.alreadySent === true) {
  return [{ json: { ...context, shouldSend: false, alreadySent: true } }];
}
return [{ json: { ...context, shouldSend: false, alreadySent: false, code: reservation?.rejectionCode || 'reservation_rejected' } }];`;

function twoWeekEmailCode(recordBase64) {
  return `const source = $input.first().json;
const escapeHtml = value => String(value).replace(/[&<>\"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[char]));
const employee = escapeHtml(source.employeeFirstName);
const employeeName = String(source.employeeName);
const manager = escapeHtml(source.managerFirstName);
const bodyContent = \`<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.6;color:#22302b"><p>Hi \${employee} and \${manager},</p><p>It’s nearly time for \${employee}’s <strong>2-Week Check-In</strong>.</p><p>This is a short, practical conversation to make sure the first couple of weeks are going well and that \${employee} understands the role, knows who to go to for help, and has the training, equipment, systems and information needed to work safely and confidently.</p><p>Please talk about what is going well, anything that is still unclear, and any early training or support needs.</p><p>\${manager}, please complete the attached <strong>2-Week New Starter Check-In Record</strong> during the conversation and record any agreed actions.</p><p>This isn’t a formal performance review — it’s an early opportunity to make sure we’re setting \${employee} up for success.</p><p>Thanks,<br>HR Manager</p></div>\`;
return [{ json: { ...source, subject: \`Your 2-Week Check-In – \${employeeName}\`, bodyContent }, binary: {
  record: { data: ${JSON.stringify(recordBase64)}, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileName: '2 Week New Starter Check-In Record.docx' }
} }];`;
}

function oneMonthEmailCode(recordBase64) {
  return `const source = $input.first().json;
const escapeHtml = value => String(value).replace(/[&<>\"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[char]));
const employee = escapeHtml(source.employeeFirstName);
const employeeName = String(source.employeeName);
const manager = escapeHtml(source.managerFirstName);
const bodyContent = \`<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.6;color:#22302b"><p>Hi \${employee} and \${manager},</p><p>\${employee} is approaching one month with MAM/Equipsy, so it’s time for the next <strong>Check-In</strong>.</p><p>This is an opportunity to discuss how the role is progressing now that the initial settling-in period has passed.</p><p>Please talk about what is making sense, where further training or support may be needed, how communication with the team is going, and whether anything is slowing \${employee} down or making the role harder than it needs to be.</p><p>\${manager}, please also provide clear feedback about what is going well and anything that should continue, improve or change.</p><p>Please complete the attached <strong>1-Month New Starter Check-In Record</strong> together and record any agreed actions, owners and due dates.</p><p>Thanks,<br>HR Manager</p></div>\`;
return [{ json: { ...source, subject: \`Your 1-Month Check-In – \${employeeName}\`, bodyContent }, binary: {
  record: { data: ${JSON.stringify(recordBase64)}, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileName: '1 Month New Starter Check-In Record.docx' }
} }];`;
}


function twoMonthEmailCode(recordBase64) {
  return `const source = $input.first().json;
const escapeHtml = value => String(value).replace(/[&<>\"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[char]));
const employee = escapeHtml(source.employeeFirstName);
const employeeName = String(source.employeeName);
const manager = escapeHtml(source.managerFirstName);
const bodyContent = \`<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.6;color:#22302b"><p>Hi \${employee} and \${manager},</p><p>It’s time for \${employee}’s <strong>2-Month Stay Interview</strong>.</p><p>This conversation is a little different from the normal Check-In. It is primarily about understanding how \${employee} is experiencing the role and identifying anything we can improve while they are still settling in.</p><p>Please talk openly about what is working well, what has been harder than expected, whether the role has matched expectations, how the team and working environment are feeling, and what additional support may help.</p><p>\${employee}, this is also your opportunity to raise anything that may be frustrating, unclear or making your job harder than it needs to be.</p><p>Please use the attached <strong>2-Month Stay Interview Record</strong> to capture the key discussion points and any agreed actions.</p><p>Thanks,<br>HR Manager</p></div>\`;
return [{ json: { ...source, subject: \`Your 2-Month Stay Interview – \${employeeName}\`, bodyContent }, binary: {
  record: { data: ${JSON.stringify(recordBase64)}, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileName: '2 Month Stay Interview Record.docx' }
} }];`;
}


function threeMonthEmailCode(recordBase64) {
  return `const source = $input.first().json;
const escapeHtml = value => String(value).replace(/[&<>\"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[char]));
const employee = escapeHtml(source.employeeFirstName);
const employeeName = String(source.employeeName);
const manager = escapeHtml(source.managerFirstName);
const bodyContent = \`<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.6;color:#22302b"><p>Hi \${employee} and \${manager},</p><p>\${employee} is approaching three months with MAM/Equipsy, which means it’s time for the <strong>3-Month Midpoint Review</strong>.</p><p>This is an important opportunity to look at progress so far and make sure everyone is clear about how things are tracking as we move through the remainder of the probation period.</p><p>The discussion will cover role understanding, work quality, reliability and attendance, communication, safety, training progress, teamwork and conduct, coachability and initiative.</p><p>It should also be a genuine two-way conversation, giving \${employee} the opportunity to discuss how the role is going and any support or development they need.</p><p>\${manager}, please complete the attached <strong>3-Month Midpoint Probation Review</strong> during the meeting and clearly discuss any areas requiring further improvement or support.</p><p>Where there are significant concerns, please contact People &amp; Culture following the meeting.</p><p>Thanks,<br>HR Manager</p></div>\`;
return [{ json: { ...source, subject: \`Your 3-Month Review – \${employeeName}\`, bodyContent }, binary: {
  record: { data: ${JSON.stringify(recordBase64)}, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileName: '3 Month Midpoint Probation Review.docx' }
} }];`;
}

function fiveMonthEmailCode(recordBase64) {
  return `const source = $input.first().json;
if (source.milestone !== '5-month') return [{ json: { ...source, valid: false, code: 'invalid_milestone' } }];
const escapeHtml = value => String(value).replace(/[&<>\"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[char]));
const employee = escapeHtml(source.employeeFirstName);
const employeeName = String(source.employeeName);
const manager = escapeHtml(source.managerFirstName);
const bodyContent = \`<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.6;color:#22302b"><p>Hi \${employee} and \${manager},</p><p>\${employee} is approaching five months with MAM/Equipsy, so it’s time for the <strong>5-Month Check-In</strong>.</p><p>The purpose of this conversation is to make sure both of you are clear about how things are progressing before the six-month review.</p><p>Please discuss what is going well, any remaining development areas, whether previous feedback or actions have been addressed, and what the priorities should be over the coming month.</p><p>Most importantly, there should be <strong>no surprises at the six-month stage</strong>. If there are concerns that could affect the probation outcome, they need to be clearly discussed now and appropriate support and expectations agreed.</p><p>\${manager}, please complete the attached <strong>5-Month No-Surprises Review</strong> during the meeting.</p><p>If there are material performance, conduct, attendance, safety or other concerns, please contact People &amp; Culture following the meeting.</p><p>Thanks,<br>HR Manager</p></div>\`;
return [{ json: { ...source, subject: \`Your 5-Month Check-In – \${employeeName}\`, bodyContent }, binary: {
  record: { data: ${JSON.stringify(recordBase64)}, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileName: '5-Month No-Surprises Review.docx' }
} }];`;
}

function sixMonthEmailCode(recordBase64) {
  return `const source = $input.first().json;
if (source.milestone !== '6-month') return [{ json: { ...source, valid: false, code: 'invalid_milestone' } }];
const escapeHtml = value => String(value).replace(/[&<>\"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[char]));
const employee = escapeHtml(source.employeeFirstName);
const employeeName = String(source.employeeName);
const manager = escapeHtml(source.managerFirstName);
const bodyContent = \`<div style=\"font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.6;color:#22302b\"><p>Hi \${employee} and \${manager},</p><p>\${employee} is approaching six months with MAM/Equipsy, so it’s time for the <strong>6-Month Review</strong>.</p><p>This conversation is an opportunity to reflect on the first six months, recognise the progress and contribution made so far, discuss any remaining development areas and agree on priorities for the next stage.</p><p>Please come prepared for an open, two-way conversation about performance, training and support, reliability, safety, teamwork, communication and the overall employee experience.</p><p>\${manager}, please complete the attached <strong>6-Month Check-In Record</strong> during the meeting and clearly record any agreed priorities, actions or follow-up requirements.</p><p>Where an employment or probation decision requires further review, please involve People &amp; Culture before communicating the final outcome.</p><p>Thanks,<br>HR Manager</p></div>\`;
return [{ json: { ...source, subject: \`Your 6-Month Review – \${employeeName}\`, bodyContent }, binary: {
  record: { data: ${JSON.stringify(recordBase64)}, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileName: '6 Month Check-In Record - Permanent and Fixed-Term.docx' }
} }];`;
}

const reviewEscalationEmailCode = `const source = $input.first().json;
const escapeHtml = value => String(value).replace(/[&<>\"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[char]));
const labels = { '2-week':'2-Week Check-In', '1-month':'1-Month Check-In', '2-month':'2-Month Stay Interview', '3-month':'3-Month Midpoint Review', '5-month':'5-Month No-Surprises Review', '6-month':'6-Month Review' };
const bodyContent = \`<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.6;color:#22302b"><p>People &amp; Culture review is required for <strong>\${escapeHtml(source.employeeName)}</strong>.</p><p><strong>Check-In:</strong> \${escapeHtml(labels[source.milestone] || source.milestone)}<br><strong>Review date:</strong> \${escapeHtml(source.reviewDate)}<br><strong>Direct Manager:</strong> \${escapeHtml(source.managerName)}</p><p><strong>Review notes</strong><br>\${escapeHtml(source.notes).replace(/\\n/g, '<br>')}</p><p><a href="https://mam-team-management-system-ten.vercel.app/?view=people&amp;section=check-ins" style="display:inline-block;padding:10px 16px;background:#ef6c24;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">Open People Hub</a></p><p>Thanks,<br>People Hub</p></div>\`;
return [{ json: { ...source, subject: \`[MAM] People & Culture review required – \${source.employeeName}\`, bodyContent } }];`;

const confirmationCode = `const context = $('Gate Durable Check-In Reservation').first().json;
const provider = $input.first().json;
const messageId = typeof provider?.id === 'string' && provider.id ? provider.id : null;
return [{ json: { action: 'confirm', eventKey: context.deliveryId, recipient: context.actualRecipient, cc: '', deliveryToken: context.deliveryToken,
  providerReceipt: { accepted: true, messageId, requestId: null, statusCode: 202 } } }];`;

const validateConfirmationCode = `const context = $('Gate Durable Check-In Reservation').first().json;
const receipt = $input.first().json;
const accepted = receipt?.ok === true && receipt?.sent === true && receipt?.alreadySent === false
  && receipt?.eventKey === context.deliveryId && receipt?.actualRecipient === context.actualRecipient
  && receipt?.actualCcRecipients === '';
return [{ json: accepted
  ? { ok: true, sent: true, alreadySent: false, deliveryId: context.deliveryId }
  : { ok: false, sent: false, alreadySent: false, deliveryId: context.deliveryId, code: 'confirmation_rejected' } }];`;

export function buildCheckInReminderWorkflow({
  mode = 'test',
  webhookCredential = { id: 'b5WWH2Mm2r1QTCHp', name: 'MAM People System - Check-In Reminder Webhook Header v2' },
} = {}) {
  if (!['test', 'live'].includes(mode)) throw new Error('Workflow mode must be test or live.');
  const twoWeekRecordBase64 = readFileSync(TWO_WEEK_RECORD_PATH).toString('base64');
  const oneMonthRecordBase64 = readFileSync(ONE_MONTH_RECORD_PATH).toString('base64');
  const twoMonthRecordBase64 = readFileSync(TWO_MONTH_RECORD_PATH).toString('base64');
  const threeMonthRecordBase64 = readFileSync(THREE_MONTH_RECORD_PATH).toString('base64');
  const fiveMonthRecordBase64 = readFileSync(FIVE_MONTH_RECORD_PATH).toString('base64');
  const sixMonthRecordBase64 = readFileSync(SIX_MONTH_RECORD_PATH).toString('base64');
  const nodes = [
    node('c2000000-0000-4000-8000-000000000001', 'Receive Check-In Request', 'n8n-nodes-base.webhook', 2.1, [-980, 0], {
      authentication: 'headerAuth', httpMethod: 'POST', path: `mam-people-hub-check-in-${mode}-v2`, responseMode: 'lastNode', options: {},
    }, { webhookId: 'c2000000-0000-4000-8000-000000000001', credentials: { httpHeaderAuth: webhookCredential } }),
    node('c2000000-0000-4000-8000-000000000002', 'Validate Check-In Request', 'n8n-nodes-base.code', 2, [-760, 0], { mode: 'runOnceForAllItems', jsCode: validatorCode(mode) }),
    node('c2000000-0000-4000-8000-000000000003', 'Valid Check-In Request?', 'n8n-nodes-base.if', 2.2, [-540, 0], {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: 'c2000000-0000-4000-8000-000000000103', leftValue: '={{ $json.valid }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {},
    }),
    node('c2000000-0000-4000-8000-000000000004', 'Reserve Durable Check-In Delivery', 'n8n-nodes-base.httpRequest', 4.2, [-300, -100], {
      method: 'POST', url: RECEIPT_URL, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', sendBody: true, contentType: 'json', specifyBody: 'json',
      jsonBody: "={{ { action: 'reserve', eventKey: $json.deliveryId, recipient: $json.actualRecipient, cc: '', legacyEventKey: null } }}",
      options: { redirect: { redirect: { followRedirects: false } }, timeout: 10000, response: { response: { responseFormat: 'json', neverError: false, fullResponse: false } } },
    }, { credentials: { httpHeaderAuth: RECEIPT_CREDENTIAL } }),
    node('c2000000-0000-4000-8000-000000000005', 'Gate Durable Check-In Reservation', 'n8n-nodes-base.code', 2, [-60, -100], { jsCode: gateCode }),
    node('c2000000-0000-4000-8000-000000000006', 'Send Check-In Email?', 'n8n-nodes-base.if', 2.2, [160, -100], {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: 'c2000000-0000-4000-8000-000000000106', leftValue: '={{ $json.shouldSend }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {},
    }),
    node('c2000000-0000-4000-8000-000000000027', 'People & Culture Review?', 'n8n-nodes-base.if', 2.2, [380, -160], {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: 'c2000000-0000-4000-8000-000000000127', leftValue: '={{ $json.kind === "review-escalation" }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {},
    }),
    node('c2000000-0000-4000-8000-000000000028', 'Build People & Culture Review Email', 'n8n-nodes-base.code', 2, [620, -400], { mode: 'runOnceForAllItems', jsCode: reviewEscalationEmailCode }),
    node('c2000000-0000-4000-8000-000000000029', 'Send People & Culture Review Email from HR', 'n8n-nodes-base.microsoftOutlook', 2, [860, -400], {
      resource: 'message', operation: 'send', toRecipients: '={{ $json.deliveryTo }}', subject: '={{ $json.subject }}', bodyContent: '={{ $json.bodyContent }}',
      additionalFields: { bodyContentType: 'html', bccRecipients: '={{ $json.deliveryBcc }}', saveToSentItems: true },
    }, { credentials: { microsoftOutlookOAuth2Api: HR_OUTLOOK_CREDENTIAL } }),
    node('c2000000-0000-4000-8000-000000000007', 'Two-Week Check-In?', 'n8n-nodes-base.if', 2.2, [620, -160], {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: 'c2000000-0000-4000-8000-000000000107', leftValue: '={{ $json.milestone === "2-week" }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {},
    }),
    node('c2000000-0000-4000-8000-000000000008', 'Build 2-Week Email and Attachment', 'n8n-nodes-base.code', 2, [620, -300], { mode: 'runOnceForAllItems', jsCode: twoWeekEmailCode(twoWeekRecordBase64) }),
    node('c2000000-0000-4000-8000-000000000009', 'Send 2-Week Email from HR', 'n8n-nodes-base.microsoftOutlook', 2, [860, -260], {
      resource: 'message', operation: 'send', toRecipients: '={{ $json.deliveryTo }}', subject: '={{ $json.subject }}', bodyContent: '={{ $json.bodyContent }}',
      additionalFields: { bodyContentType: 'html', bccRecipients: '={{ $json.deliveryBcc }}', saveToSentItems: true, attachments: { attachments: [{ binaryPropertyName: 'record' }] } },
    }, { credentials: { microsoftOutlookOAuth2Api: HR_OUTLOOK_CREDENTIAL } }),
    node('c2000000-0000-4000-8000-000000000010', 'Build 5-Month No-Surprises Review Email and Attachment', 'n8n-nodes-base.code', 2, [1580, 180], { mode: 'runOnceForAllItems', jsCode: fiveMonthEmailCode(fiveMonthRecordBase64) }),
    node('c2000000-0000-4000-8000-000000000011', 'Send 5-Month No-Surprises Review Email from HR', 'n8n-nodes-base.microsoftOutlook', 2, [1820, 180], {
      resource: 'message', operation: 'send', toRecipients: '={{ $json.deliveryTo }}', subject: '={{ $json.subject }}', bodyContent: '={{ $json.bodyContent }}',
      additionalFields: { bodyContentType: 'html', bccRecipients: '={{ $json.deliveryBcc }}', saveToSentItems: true, attachments: { attachments: [{ binaryPropertyName: 'record' }] } },
    }, { credentials: { microsoftOutlookOAuth2Api: HR_OUTLOOK_CREDENTIAL } }),
    node('c2000000-0000-4000-8000-000000000012', 'Build Durable Check-In Confirmation', 'n8n-nodes-base.code', 2, [1100, -160], { mode: 'runOnceForAllItems', jsCode: confirmationCode }),
    node('c2000000-0000-4000-8000-000000000013', 'Confirm Durable Check-In Delivery', 'n8n-nodes-base.httpRequest', 4.2, [1340, -160], {
      method: 'POST', url: RECEIPT_URL, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: '={{ $json }}',
      options: { redirect: { redirect: { followRedirects: false } }, timeout: 10000, response: { response: { responseFormat: 'json', neverError: false, fullResponse: false } } },
    }, { credentials: { httpHeaderAuth: RECEIPT_CREDENTIAL } }),
    node('c2000000-0000-4000-8000-000000000014', 'Validate Durable Check-In Confirmation', 'n8n-nodes-base.code', 2, [1580, -160], { mode: 'runOnceForAllItems', jsCode: validateConfirmationCode }),
    node('c2000000-0000-4000-8000-000000000015', 'Already Delivered?', 'n8n-nodes-base.if', 2.2, [380, 80], {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: 'c2000000-0000-4000-8000-000000000115', leftValue: '={{ $json.alreadySent }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {},
    }),
    node('c2000000-0000-4000-8000-000000000016', 'Return Check-In Duplicate', 'n8n-nodes-base.code', 2, [620, 60], { jsCode: "return [{ json: { ok: true, sent: false, alreadySent: true, deliveryId: $json.deliveryId } }];" }),
    node('c2000000-0000-4000-8000-000000000017', 'Return Check-In Rejection', 'n8n-nodes-base.code', 2, [620, 140], { jsCode: "return [{ json: { ok: false, sent: false, alreadySent: false, deliveryId: $json.deliveryId || 'invalid', code: $json.code || 'rejected' } }];" }),
    node('c2000000-0000-4000-8000-000000000018', 'One-Month Check-In?', 'n8n-nodes-base.if', 2.2, [620, -80], {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: 'c2000000-0000-4000-8000-000000000118', leftValue: '={{ $json.milestone === "1-month" }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {},
    }),
    node('c2000000-0000-4000-8000-000000000019', 'Build 1-Month Email and Attachment', 'n8n-nodes-base.code', 2, [860, -140], { mode: 'runOnceForAllItems', jsCode: oneMonthEmailCode(oneMonthRecordBase64) }),
    node('c2000000-0000-4000-8000-000000000020', 'Send 1-Month Email from HR', 'n8n-nodes-base.microsoftOutlook', 2, [1100, -140], {
      resource: 'message', operation: 'send', toRecipients: '={{ $json.deliveryTo }}', subject: '={{ $json.subject }}', bodyContent: '={{ $json.bodyContent }}',
      additionalFields: { bodyContentType: 'html', bccRecipients: '={{ $json.deliveryBcc }}', saveToSentItems: true, attachments: { attachments: [{ binaryPropertyName: 'record' }] } },
    }, { credentials: { microsoftOutlookOAuth2Api: HR_OUTLOOK_CREDENTIAL } }),
    node('c2000000-0000-4000-8000-000000000021', 'Two-Month Stay Interview?', 'n8n-nodes-base.if', 2.2, [860, -40], {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: 'c2000000-0000-4000-8000-000000000121', leftValue: '={{ $json.milestone === "2-month" }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {},
    }),
    node('c2000000-0000-4000-8000-000000000022', 'Build 2-Month Stay Interview Email and Attachment', 'n8n-nodes-base.code', 2, [1100, 0], { mode: 'runOnceForAllItems', jsCode: twoMonthEmailCode(twoMonthRecordBase64) }),
    node('c2000000-0000-4000-8000-000000000023', 'Send 2-Month Stay Interview Email from HR', 'n8n-nodes-base.microsoftOutlook', 2, [1340, 0], {
      resource: 'message', operation: 'send', toRecipients: '={{ $json.deliveryTo }}', subject: '={{ $json.subject }}', bodyContent: '={{ $json.bodyContent }}',
      additionalFields: { bodyContentType: 'html', bccRecipients: '={{ $json.deliveryBcc }}', saveToSentItems: true, attachments: { attachments: [{ binaryPropertyName: 'record' }] } },
    }, { credentials: { microsoftOutlookOAuth2Api: HR_OUTLOOK_CREDENTIAL } }),
    node('c2000000-0000-4000-8000-000000000024', 'Three-Month Midpoint Review?', 'n8n-nodes-base.if', 2.2, [1100, 100], {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: 'c2000000-0000-4000-8000-000000000124', leftValue: '={{ $json.milestone === "3-month" }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {},
    }),
    node('c2000000-0000-4000-8000-000000000025', 'Build 3-Month Midpoint Review Email and Attachment', 'n8n-nodes-base.code', 2, [1340, 100], { mode: 'runOnceForAllItems', jsCode: threeMonthEmailCode(threeMonthRecordBase64) }),
    node('c2000000-0000-4000-8000-000000000026', 'Send 3-Month Midpoint Review Email from HR', 'n8n-nodes-base.microsoftOutlook', 2, [1580, 100], {
      resource: 'message', operation: 'send', toRecipients: '={{ $json.deliveryTo }}', subject: '={{ $json.subject }}', bodyContent: '={{ $json.bodyContent }}',
      additionalFields: { bodyContentType: 'html', bccRecipients: '={{ $json.deliveryBcc }}', saveToSentItems: true, attachments: { attachments: [{ binaryPropertyName: 'record' }] } },
    }, { credentials: { microsoftOutlookOAuth2Api: HR_OUTLOOK_CREDENTIAL } }),
    node('c2000000-0000-4000-8000-000000000030', 'Five-Month No-Surprises Review?', 'n8n-nodes-base.if', 2.2, [1340, 260], {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: 'c2000000-0000-4000-8000-000000000130', leftValue: '={{ $json.milestone === "5-month" }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {},
    }),
    node('c2000000-0000-4000-8000-000000000031', 'Six-Month Check-In?', 'n8n-nodes-base.if', 2.2, [1580, 320], {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: 'c2000000-0000-4000-8000-000000000131', leftValue: '={{ $json.milestone === "6-month" }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {},
    }),
    node('c2000000-0000-4000-8000-000000000032', 'Build 6-Month Check-In Email and Attachment', 'n8n-nodes-base.code', 2, [1820, 320], { mode: 'runOnceForAllItems', jsCode: sixMonthEmailCode(sixMonthRecordBase64) }),
    node('c2000000-0000-4000-8000-000000000033', 'Send 6-Month Check-In Email from HR', 'n8n-nodes-base.microsoftOutlook', 2, [2060, 320], {
      resource: 'message', operation: 'send', toRecipients: '={{ $json.deliveryTo }}', subject: '={{ $json.subject }}', bodyContent: '={{ $json.bodyContent }}',
      additionalFields: { bodyContentType: 'html', bccRecipients: '={{ $json.deliveryBcc }}', saveToSentItems: true, attachments: { attachments: [{ binaryPropertyName: 'record' }] } },
    }, { credentials: { microsoftOutlookOAuth2Api: HR_OUTLOOK_CREDENTIAL } }),
  ];
  const connections = {
    'Receive Check-In Request': { main: [[{ node: 'Validate Check-In Request', type: 'main', index: 0 }]] },
    'Validate Check-In Request': { main: [[{ node: 'Valid Check-In Request?', type: 'main', index: 0 }]] },
    'Valid Check-In Request?': { main: [[{ node: 'Reserve Durable Check-In Delivery', type: 'main', index: 0 }], [{ node: 'Return Check-In Rejection', type: 'main', index: 0 }]] },
    'Reserve Durable Check-In Delivery': { main: [[{ node: 'Gate Durable Check-In Reservation', type: 'main', index: 0 }]] },
    'Gate Durable Check-In Reservation': { main: [[{ node: 'Send Check-In Email?', type: 'main', index: 0 }]] },
    'Send Check-In Email?': { main: [[{ node: 'People & Culture Review?', type: 'main', index: 0 }], [{ node: 'Already Delivered?', type: 'main', index: 0 }]] },
    'People & Culture Review?': { main: [[{ node: 'Build People & Culture Review Email', type: 'main', index: 0 }], [{ node: 'Two-Week Check-In?', type: 'main', index: 0 }]] },
    'Build People & Culture Review Email': { main: [[{ node: 'Send People & Culture Review Email from HR', type: 'main', index: 0 }]] },
    'Send People & Culture Review Email from HR': { main: [[{ node: 'Build Durable Check-In Confirmation', type: 'main', index: 0 }]] },
    'Two-Week Check-In?': { main: [[{ node: 'Build 2-Week Email and Attachment', type: 'main', index: 0 }], [{ node: 'One-Month Check-In?', type: 'main', index: 0 }]] },
    'Build 2-Week Email and Attachment': { main: [[{ node: 'Send 2-Week Email from HR', type: 'main', index: 0 }]] },
    'Send 2-Week Email from HR': { main: [[{ node: 'Build Durable Check-In Confirmation', type: 'main', index: 0 }]] },
    'One-Month Check-In?': { main: [[{ node: 'Build 1-Month Email and Attachment', type: 'main', index: 0 }], [{ node: 'Two-Month Stay Interview?', type: 'main', index: 0 }]] },
    'Build 1-Month Email and Attachment': { main: [[{ node: 'Send 1-Month Email from HR', type: 'main', index: 0 }]] },
    'Send 1-Month Email from HR': { main: [[{ node: 'Build Durable Check-In Confirmation', type: 'main', index: 0 }]] },
    'Two-Month Stay Interview?': { main: [[{ node: 'Build 2-Month Stay Interview Email and Attachment', type: 'main', index: 0 }], [{ node: 'Three-Month Midpoint Review?', type: 'main', index: 0 }]] },
    'Build 2-Month Stay Interview Email and Attachment': { main: [[{ node: 'Send 2-Month Stay Interview Email from HR', type: 'main', index: 0 }]] },
    'Send 2-Month Stay Interview Email from HR': { main: [[{ node: 'Build Durable Check-In Confirmation', type: 'main', index: 0 }]] },
    'Three-Month Midpoint Review?': { main: [[{ node: 'Build 3-Month Midpoint Review Email and Attachment', type: 'main', index: 0 }], [{ node: 'Five-Month No-Surprises Review?', type: 'main', index: 0 }]] },
    'Build 3-Month Midpoint Review Email and Attachment': { main: [[{ node: 'Send 3-Month Midpoint Review Email from HR', type: 'main', index: 0 }]] },
    'Send 3-Month Midpoint Review Email from HR': { main: [[{ node: 'Build Durable Check-In Confirmation', type: 'main', index: 0 }]] },
    'Five-Month No-Surprises Review?': { main: [[{ node: 'Build 5-Month No-Surprises Review Email and Attachment', type: 'main', index: 0 }], [{ node: 'Six-Month Check-In?', type: 'main', index: 0 }]] },
    'Six-Month Check-In?': { main: [[{ node: 'Build 6-Month Check-In Email and Attachment', type: 'main', index: 0 }], [{ node: 'Return Check-In Rejection', type: 'main', index: 0 }]] },
    'Build 5-Month No-Surprises Review Email and Attachment': { main: [[{ node: 'Send 5-Month No-Surprises Review Email from HR', type: 'main', index: 0 }]] },
    'Send 5-Month No-Surprises Review Email from HR': { main: [[{ node: 'Build Durable Check-In Confirmation', type: 'main', index: 0 }]] },
    'Build 6-Month Check-In Email and Attachment': { main: [[{ node: 'Send 6-Month Check-In Email from HR', type: 'main', index: 0 }]] },
    'Send 6-Month Check-In Email from HR': { main: [[{ node: 'Build Durable Check-In Confirmation', type: 'main', index: 0 }]] },
    'Build Durable Check-In Confirmation': { main: [[{ node: 'Confirm Durable Check-In Delivery', type: 'main', index: 0 }]] },
    'Confirm Durable Check-In Delivery': { main: [[{ node: 'Validate Durable Check-In Confirmation', type: 'main', index: 0 }]] },
    'Already Delivered?': { main: [[{ node: 'Return Check-In Duplicate', type: 'main', index: 0 }], [{ node: 'Return Check-In Rejection', type: 'main', index: 0 }]] },
  };
  return { name: `MAM People Hub - Check-In Emails (${mode === 'test' ? 'Marketing Test' : 'Live'})`, nodes, connections,
    settings: { executionOrder: 'v1', timezone: 'Australia/Melbourne', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'none', saveExecutionProgress: false } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  const mode = process.argv[3] ?? 'test';
  if (!output) throw new Error('Usage: node scripts/build-check-in-reminder-workflow.mjs <output.json> [test|live]');
  writeFileSync(output, JSON.stringify(buildCheckInReminderWorkflow({ mode }), null, 2) + '\n', { mode: 0o600 });
}
