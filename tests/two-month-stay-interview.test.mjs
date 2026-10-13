import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildCheckInReminderWorkflow,
  TWO_MONTH_RECORD_PATH,
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
    deliveryId: `checkin:${reminderId}:2-month:initial:test`,
    employee: {
      firstName: 'Taylor', lastName: 'Starter', role: 'Coordinator', department: 'Operations',
      workEmail: 'work@example.test', personalEmail: 'personal@example.test',
    },
    manager: { name: 'Morgan Manager', email: 'manager@example.test' },
    milestone: '2-month', dueDate: '2026-11-13', reminder: 'initial', resources: {},
    ...overrides,
  };
}

test('Marketing test workflow hard-routes the 2-Month email and attaches the supplied record from AI', () => {
  const nodes = nodeMap(buildCheckInReminderWorkflow({ mode: 'test' }));
  const validate = new Function('$input', nodes['Validate Check-In Request'].parameters.jsCode);
  const [result] = validate({ first: () => ({ json: { body: payload() } }) });
  assert.equal(result.json.valid, true);
  assert.equal(result.json.actualRecipient, TEST_RECIPIENT);

  const build = new Function('$input', nodes['Build 2-Month Stay Interview Email and Attachment'].parameters.jsCode);
  const [email] = build({ first: () => ({ json: result.json }) });
  assert.equal(email.json.subject, 'Your 2-Month Stay Interview – Taylor Starter');
  assert.match(email.json.bodyContent, /understanding how Taylor is experiencing the role/);
  assert.match(email.json.bodyContent, /key discussion points and any agreed actions/);
  assert.equal(email.binary.record.fileName, '2 Month Stay Interview Record.docx');
  assert.deepEqual(Buffer.from(email.binary.record.data, 'base64'), readFileSync(TWO_MONTH_RECORD_PATH));
  assert.equal(nodes['Send 2-Month Stay Interview Email from HR'].credentials.microsoftOutlookOAuth2Api.name, 'Microsoft Outlook - ai@mobilityaccess.com.au');
});

test('Live 2-Month workflow sends once to both employee addresses and the direct manager', () => {
  const nodes = nodeMap(buildCheckInReminderWorkflow({ mode: 'live' }));
  const validate = new Function('$input', nodes['Validate Check-In Request'].parameters.jsCode);
  const live = payload({ mode: 'live', deliveryId: `checkin:${reminderId}:2-month:initial:live` });
  const [result] = validate({ first: () => ({ json: { body: live } }) });
  assert.equal(result.json.actualRecipient, 'manager@example.test,personal@example.test,work@example.test');
});

test('2-Month workflow rejects a request without an employee email', () => {
  const nodes = nodeMap(buildCheckInReminderWorkflow({ mode: 'test' }));
  const validate = new Function('$input', nodes['Validate Check-In Request'].parameters.jsCode);
  const invalid = payload({ employee: { ...payload().employee, workEmail: null, personalEmail: null } });
  const [result] = validate({ first: () => ({ json: { body: invalid } }) });
  assert.equal(result.json.valid, false);
});
