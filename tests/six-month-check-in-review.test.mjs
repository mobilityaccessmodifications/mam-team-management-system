import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildCheckInReminderWorkflow,
  SIX_MONTH_RECORD_PATH,
  TEST_RECIPIENT,
} from '../scripts/build-check-in-reminder-workflow.mjs';

const reminderId = '10000000-0000-4000-8000-000000000006';
const reviewId = '20000000-0000-4000-8000-000000000006';

function nodeMap(workflow) {
  return Object.fromEntries(workflow.nodes.map((node) => [node.name, node]));
}

function reminderPayload(overrides = {}) {
  return {
    version: 1,
    event: 'checkin-reminder',
    mode: 'test',
    deliveryId: `checkin:${reminderId}:6-month:initial:test`,
    employee: {
      firstName: 'Taylor',
      lastName: 'Starter',
      role: 'Coordinator',
      department: 'Operations',
      workEmail: 'work@example.test',
      personalEmail: 'personal@example.test',
    },
    manager: { name: 'Morgan Manager', email: 'manager@example.test' },
    milestone: '6-month',
    dueDate: '2027-03-01',
    reminder: 'initial',
    resources: {},
    ...overrides,
  };
}

test('six-month checklist email follows the approved copy and attaches the provided record', () => {
  const workflow = buildCheckInReminderWorkflow({ mode: 'test' });
  const nodes = nodeMap(workflow);
  const validate = new Function('$input', nodes['Validate Check-In Request'].parameters.jsCode);
  const [result] = validate({ first: () => ({ json: { body: reminderPayload() } }) });
  assert.equal(result.json.valid, true);
  assert.equal(result.json.actualRecipient, TEST_RECIPIENT);
  assert.equal(result.json.deliveryTo, TEST_RECIPIENT);
  assert.equal(result.json.deliveryBcc, '');

  const build = new Function('$input', nodes['Build 6-Month Check-In Email and Attachment'].parameters.jsCode);
  const [email] = build({ first: () => ({ json: result.json }) });
  assert.equal(email.json.subject, 'Your 6-Month Review – Taylor Starter');
  assert.match(email.json.bodyContent, /approaching six months with MAM\/Equipsy/);
  assert.match(email.json.bodyContent, /performance, training and support, reliability, safety, teamwork, communication and the overall employee experience/);
  assert.match(email.json.bodyContent, /before communicating the final outcome/);
  assert.equal(email.binary.record.fileName, '6 Month Check-In Record - Permanent and Fixed-Term.docx');
  const attachment = readFileSync(SIX_MONTH_RECORD_PATH);
  assert.deepEqual(Buffer.from(email.binary.record.data, 'base64'), attachment);
  assert.equal(createHash('sha256').update(attachment).digest('hex'), '58484c5b70fbb50cee967e1913135544e7217337a80c4809898730d30d99e601');
  assert.equal(
    nodes['Send 6-Month Check-In Email from HR'].credentials.microsoftOutlookOAuth2Api.name,
    'Microsoft Outlook - ai@mobilityaccess.com.au',
  );
  assert.equal(workflow.settings.saveDataErrorExecution, 'none');
});

test('live six-month emails go to employee and manager while the personal address stays BCC', () => {
  const nodes = nodeMap(buildCheckInReminderWorkflow({ mode: 'live' }));
  const validate = new Function('$input', nodes['Validate Check-In Request'].parameters.jsCode);
  const live = reminderPayload({
    mode: 'live',
    deliveryId: `checkin:${reminderId}:6-month:initial:live`,
  });
  const [result] = validate({ first: () => ({ json: { body: live } }) });
  assert.equal(result.json.valid, true);
  assert.equal(result.json.actualRecipient, 'manager@example.test,personal@example.test,work@example.test');
  assert.equal(result.json.deliveryTo, 'manager@example.test,work@example.test');
  assert.equal(result.json.deliveryBcc, 'personal@example.test');
});

test('six-month People & Culture escalations remain Marketing-only in test mode', () => {
  const nodes = nodeMap(buildCheckInReminderWorkflow({ mode: 'test' }));
  const validate = new Function('$input', nodes['Validate Check-In Request'].parameters.jsCode);
  const payload = {
    version: 1,
    event: 'checkin-review-escalation',
    mode: 'test',
    deliveryId: `checkin-review:${reviewId}:hr:1:test`,
    employeeName: 'Taylor Starter',
    managerName: 'Morgan Manager',
    milestone: '6-month',
    reviewDate: '2027-03-01',
    notes: 'P&C approval is required before an outcome is communicated.',
    reviewVersion: 1,
    recipient: 'untrusted@example.test',
  };
  const [result] = validate({ first: () => ({ json: { body: payload } }) });
  assert.equal(result.json.valid, true);
  assert.equal(result.json.actualRecipient, TEST_RECIPIENT);
  assert.equal(result.json.deliveryTo, TEST_RECIPIENT);
  assert.equal(Object.hasOwn(result.json, 'recipient'), false);

  const build = new Function('$input', nodes['Build People & Culture Review Email'].parameters.jsCode);
  const [email] = build({ first: () => ({ json: result.json }) });
  assert.match(email.json.subject, /Taylor Starter/);
  assert.match(email.json.bodyContent, /6-Month Review/);
  assert.match(email.json.bodyContent, /P&amp;C approval is required/);
});
