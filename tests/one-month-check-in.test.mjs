import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildCheckInReminderWorkflow,
  ONE_MONTH_RECORD_PATH,
  TEST_RECIPIENT,
} from '../scripts/build-check-in-reminder-workflow.mjs';

const reminderId = '10000000-0000-4000-8000-000000000002';

function nodeMap(workflow) {
  return Object.fromEntries(workflow.nodes.map((node) => [node.name, node]));
}

function payload(overrides = {}) {
  return {
    version: 1,
    event: 'checkin-reminder',
    mode: 'test',
    deliveryId: `checkin:${reminderId}:1-month:initial:test`,
    employee: {
      firstName: 'Taylor', lastName: 'Starter', role: 'Coordinator', department: 'Operations',
      workEmail: 'work@example.test', personalEmail: 'personal@example.test',
    },
    manager: { name: 'Morgan Manager', email: 'manager@example.test' },
    milestone: '1-month', dueDate: '2026-10-14', reminder: 'initial', resources: {},
    ...overrides,
  };
}

test('Marketing test workflow hard-routes the 1-Month email and attaches the supplied record from HR', () => {
  const nodes = nodeMap(buildCheckInReminderWorkflow({ mode: 'test' }));
  const validate = new Function('$input', nodes['Validate Check-In Request'].parameters.jsCode);
  const [result] = validate({ first: () => ({ json: { body: payload() } }) });
  assert.equal(result.json.valid, true);
  assert.equal(result.json.actualRecipient, TEST_RECIPIENT);

  const build = new Function('$input', nodes['Build 1-Month Email and Attachment'].parameters.jsCode);
  const [email] = build({ first: () => ({ json: result.json }) });
  assert.equal(email.json.subject, 'Your 1-Month Check-In – Taylor Starter');
  assert.match(email.json.bodyContent, /approaching one month with MAM\/Equipsy/);
  assert.match(email.json.bodyContent, /actions, owners and due dates/);
  assert.equal(email.binary.record.fileName, '1 Month New Starter Check-In Record.docx');
  assert.equal(Buffer.from(email.binary.record.data, 'base64').length, readFileSync(ONE_MONTH_RECORD_PATH).length);
  assert.equal(nodes['Send 1-Month Email from HR'].credentials.microsoftOutlookOAuth2Api.name, 'Microsoft Outlook account - hr@mobilityaccess.com.au');
});

test('Live 1-Month workflow sends once to both employee addresses and the direct manager', () => {
  const nodes = nodeMap(buildCheckInReminderWorkflow({ mode: 'live' }));
  const validate = new Function('$input', nodes['Validate Check-In Request'].parameters.jsCode);
  const live = payload({ mode: 'live', deliveryId: `checkin:${reminderId}:1-month:initial:live` });
  const [result] = validate({ first: () => ({ json: { body: live } }) });
  assert.equal(result.json.actualRecipient, 'manager@example.test,personal@example.test,work@example.test');
});

test('1-Month workflow rejects a request without an employee email', () => {
  const nodes = nodeMap(buildCheckInReminderWorkflow({ mode: 'test' }));
  const validate = new Function('$input', nodes['Validate Check-In Request'].parameters.jsCode);
  const invalid = payload({ employee: { ...payload().employee, workEmail: null, personalEmail: null } });
  const [result] = validate({ first: () => ({ json: { body: invalid } }) });
  assert.equal(result.json.valid, false);
});
