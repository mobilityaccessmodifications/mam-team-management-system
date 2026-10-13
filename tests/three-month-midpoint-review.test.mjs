import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildCheckInReminderWorkflow,
  THREE_MONTH_RECORD_PATH,
  TEST_RECIPIENT,
} from '../scripts/build-check-in-reminder-workflow.mjs';

const reminderId = '10000000-0000-4000-8000-000000000003';

function nodeMap(workflow) {
  return Object.fromEntries(workflow.nodes.map((node) => [node.name, node]));
}

function payload(overrides = {}) {
  return {
    version: 1,
    event: 'checkin-reminder',
    mode: 'test',
    deliveryId: `checkin:${reminderId}:3-month:initial:test`,
    employee: {
      firstName: 'Taylor', lastName: 'Starter', role: 'Coordinator', department: 'Operations',
      workEmail: 'work@example.test', personalEmail: 'personal@example.test',
    },
    manager: { name: 'Morgan Manager', email: 'manager@example.test' },
    milestone: '3-month', dueDate: '2026-12-14', reminder: 'initial', resources: {},
    ...overrides,
  };
}

test('Marketing test workflow hard-routes the 3-Month email and attaches the supplied review from AI', () => {
  const nodes = nodeMap(buildCheckInReminderWorkflow({ mode: 'test' }));
  const validate = new Function('$input', nodes['Validate Check-In Request'].parameters.jsCode);
  const [result] = validate({ first: () => ({ json: { body: payload() } }) });
  assert.equal(result.json.valid, true);
  assert.equal(result.json.actualRecipient, TEST_RECIPIENT);

  const build = new Function('$input', nodes['Build 3-Month Midpoint Review Email and Attachment'].parameters.jsCode);
  const [email] = build({ first: () => ({ json: result.json }) });
  assert.equal(email.json.subject, 'Your 3-Month Review – Taylor Starter');
  assert.match(email.json.bodyContent, /role understanding, work quality, reliability and attendance/);
  assert.match(email.json.bodyContent, /contact People &amp; Culture following the meeting/);
  assert.equal(email.binary.record.fileName, '3 Month Midpoint Probation Review.docx');
  assert.deepEqual(Buffer.from(email.binary.record.data, 'base64'), readFileSync(THREE_MONTH_RECORD_PATH));
  assert.equal(nodes['Send 3-Month Midpoint Review Email from HR'].credentials.microsoftOutlookOAuth2Api.name, 'Microsoft Outlook - ai@mobilityaccess.com.au');
});

test('Live 3-Month workflow sends once to both employee addresses and the direct manager', () => {
  const nodes = nodeMap(buildCheckInReminderWorkflow({ mode: 'live' }));
  const validate = new Function('$input', nodes['Validate Check-In Request'].parameters.jsCode);
  const live = payload({ mode: 'live', deliveryId: `checkin:${reminderId}:3-month:initial:live` });
  const [result] = validate({ first: () => ({ json: { body: live } }) });
  assert.equal(result.json.actualRecipient, 'manager@example.test,personal@example.test,work@example.test');
});

test('3-Month workflow rejects a request without an employee email', () => {
  const nodes = nodeMap(buildCheckInReminderWorkflow({ mode: 'test' }));
  const validate = new Function('$input', nodes['Validate Check-In Request'].parameters.jsCode);
  const invalid = payload({ employee: { ...payload().employee, workEmail: null, personalEmail: null } });
  const [result] = validate({ first: () => ({ json: { body: invalid } }) });
  assert.equal(result.json.valid, false);
});
