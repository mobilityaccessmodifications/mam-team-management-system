import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildCheckInReminderWorkflow,
  TEST_RECIPIENT,
  TWO_WEEK_RECORD_PATH,
} from '../scripts/build-check-in-reminder-workflow.mjs';

const reminderId = '10000000-0000-4000-8000-000000000001';

function nodeMap(workflow) {
  return Object.fromEntries(workflow.nodes.map((node) => [node.name, node]));
}

function payload(overrides = {}) {
  return {
    version: 1,
    event: 'checkin-reminder',
    mode: 'test',
    deliveryId: `checkin:${reminderId}:2-week:initial:test`,
    employee: {
      firstName: 'Taylor',
      lastName: 'Starter',
      role: 'Coordinator',
      department: 'Operations',
      workEmail: 'same@example.test',
      personalEmail: 'personal@example.test',
    },
    manager: { name: 'Morgan Manager', email: 'manager@example.test' },
    milestone: '2-week',
    dueDate: '2026-10-19',
    reminder: 'initial',
    resources: {},
    ...overrides,
  };
}

test('Marketing test workflow hard-routes the 2-Week email and attaches the supplied record from HR', () => {
  const workflow = buildCheckInReminderWorkflow({ mode: 'test' });
  const nodes = nodeMap(workflow);
  const validate = new Function('$input', nodes['Validate Check-In Request'].parameters.jsCode);
  const [result] = validate({ first: () => ({ json: { body: payload() } }) });
  assert.equal(result.json.valid, true);
  assert.equal(result.json.actualRecipient, TEST_RECIPIENT);
  assert.equal(result.json.managerFirstName, 'Morgan');

  const build = new Function('$input', nodes['Build 2-Week Email and Attachment'].parameters.jsCode);
  const [email] = build({ first: () => ({ json: result.json }) });
  assert.equal(email.json.subject, 'Your 2-Week Check-In – Taylor Starter');
  assert.match(email.json.bodyContent, /isn’t a formal performance review/);
  assert.equal(email.binary.record.fileName, '2 Week New Starter Check-In Record.docx');
  assert.equal(Buffer.from(email.binary.record.data, 'base64').length, readFileSync(TWO_WEEK_RECORD_PATH).length);

  const send = nodes['Send 2-Week Email from HR'];
  assert.equal(send.parameters.toRecipients, '={{ $json.actualRecipient }}');
  assert.equal(send.credentials.microsoftOutlookOAuth2Api.name, 'Microsoft Outlook account - hr@mobilityaccess.com.au');
});

test('Live 2-Week workflow de-duplicates employee work, personal and direct-manager recipients', () => {
  const workflow = buildCheckInReminderWorkflow({ mode: 'live' });
  const validate = new Function('$input', nodeMap(workflow)['Validate Check-In Request'].parameters.jsCode);
  const livePayload = payload({
    mode: 'live',
    deliveryId: `checkin:${reminderId}:2-week:initial:live`,
    employee: { ...payload().employee, workEmail: 'same@example.test', personalEmail: 'same@example.test' },
  });
  const [result] = validate({ first: () => ({ json: { body: livePayload } }) });
  assert.equal(result.json.actualRecipient, 'manager@example.test,same@example.test');
});

test('2-Week workflow rejects a request without an employee email', () => {
  const workflow = buildCheckInReminderWorkflow({ mode: 'test' });
  const validate = new Function('$input', nodeMap(workflow)['Validate Check-In Request'].parameters.jsCode);
  const invalid = payload({ employee: { ...payload().employee, workEmail: null, personalEmail: null } });
  const [result] = validate({ first: () => ({ json: { body: invalid } }) });
  assert.equal(result.json.valid, false);
});
