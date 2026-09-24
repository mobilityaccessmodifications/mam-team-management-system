import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildCheckInReminderWorkflow,
  SIX_MONTH_CASUAL_RECORD_PATH,
  TEST_RECIPIENT,
} from '../scripts/build-check-in-reminder-workflow.mjs';

const reminderId = '10000000-0000-4000-8000-000000000008';
const reviewId = '20000000-0000-4000-8000-000000000008';

function nodeMap(workflow) {
  return Object.fromEntries(workflow.nodes.map((node) => [node.name, node]));
}

function reminderPayload(overrides = {}) {
  return {
    version: 1,
    event: 'checkin-reminder',
    mode: 'test',
    deliveryId: `checkin:${reminderId}:6-month-casual:initial:test`,
    employee: {
      firstName: 'Taylor',
      lastName: 'Starter',
      role: 'Coordinator',
      department: 'Operations',
      workEmail: 'work@example.test',
      personalEmail: 'personal@example.test',
    },
    manager: { name: 'Morgan Manager', email: 'manager@example.test' },
    milestone: '6-month-casual',
    dueDate: '2027-03-01',
    reminder: 'initial',
    resources: {},
    ...overrides,
  };
}

test('Marketing test workflow sends the Casual Check-In wording and exact attached form only to Marketing', () => {
  const workflow = buildCheckInReminderWorkflow({ mode: 'test' });
  const nodes = nodeMap(workflow);
  const validate = new Function('$input', nodes['Validate Check-In Request'].parameters.jsCode);
  const [result] = validate({ first: () => ({ json: { body: reminderPayload() } }) });
  assert.equal(result.json.valid, true);
  assert.equal(result.json.actualRecipient, TEST_RECIPIENT);
  assert.equal(result.json.deliveryTo, TEST_RECIPIENT);
  assert.equal(result.json.deliveryBcc, '');

  const build = new Function('$input', nodes['Build 6-Month Casual Check-In Email and Attachment'].parameters.jsCode);
  const [email] = build({ first: () => ({ json: result.json }) });
  assert.equal(email.json.subject, 'Your 6-Month Check-In – Taylor Starter');
  assert.match(email.json.bodyContent, /two-way conversation/);
  assert.match(email.json.bodyContent, /ongoing casual employment, current working patterns/);
  assert.match(email.json.bodyContent, /No commitments about guaranteed hours or permanent employment/);
  assert.match(email.json.bodyContent, /record the agreed priorities for the next three months/);
  assert.equal(email.binary.record.fileName, '6 Month Check-In Form - Casual.docx');
  const attachment = readFileSync(SIX_MONTH_CASUAL_RECORD_PATH);
  assert.deepEqual(Buffer.from(email.binary.record.data, 'base64'), attachment);
  assert.equal(createHash('sha256').update(attachment).digest('hex'), '63aeccca2cb91bbca7311a8b4e7214352051a072f523ebb1962b7b1e33fdd710');
  assert.equal(nodes['Send 6-Month Casual Check-In Email from HR'].parameters.toRecipients, '={{ $json.deliveryTo }}');
  assert.equal(
    nodes['Send 6-Month Casual Check-In Email from HR'].credentials.microsoftOutlookOAuth2Api.name,
    'Microsoft Outlook account - hr@mobilityaccess.com.au',
  );
  assert.equal(workflow.settings.saveDataErrorExecution, 'none');
});

test('Live Casual Check-In includes the employee and manager while keeping personal email BCC', () => {
  const nodes = nodeMap(buildCheckInReminderWorkflow({ mode: 'live' }));
  const validate = new Function('$input', nodes['Validate Check-In Request'].parameters.jsCode);
  const live = reminderPayload({ mode: 'live', deliveryId: `checkin:${reminderId}:6-month-casual:initial:live` });
  const [result] = validate({ first: () => ({ json: { body: live } }) });
  assert.equal(result.json.valid, true);
  assert.equal(result.json.actualRecipient, 'manager@example.test,personal@example.test,work@example.test');
  assert.equal(result.json.deliveryTo, 'manager@example.test,work@example.test');
  assert.equal(result.json.deliveryBcc, 'personal@example.test');
});

test('Casual People & Culture review alerts stay Marketing-only in test mode', () => {
  const nodes = nodeMap(buildCheckInReminderWorkflow({ mode: 'test' }));
  const validate = new Function('$input', nodes['Validate Check-In Request'].parameters.jsCode);
  const payload = {
    version: 1,
    event: 'checkin-review-escalation',
    mode: 'test',
    deliveryId: `checkin-review:${reviewId}:hr:1:test`,
    employeeName: 'Taylor Starter',
    managerName: 'Morgan Manager',
    milestone: '6-month-casual',
    reviewDate: '2027-03-01',
    notes: 'Discuss permanent employment options with People & Culture.',
    reviewVersion: 1,
    recipient: 'attacker@example.test',
  };
  const [result] = validate({ first: () => ({ json: { body: payload } }) });
  assert.equal(result.json.valid, true);
  assert.equal(result.json.actualRecipient, TEST_RECIPIENT);
  assert.equal(result.json.deliveryTo, TEST_RECIPIENT);
  assert.equal(result.json.deliveryBcc, '');
  assert.equal(Object.hasOwn(result.json, 'recipient'), false);

  const build = new Function('$input', nodes['Build People & Culture Review Email'].parameters.jsCode);
  const [email] = build({ first: () => ({ json: result.json }) });
  assert.match(email.json.bodyContent, /6-Month Casual Check-In/);
});
