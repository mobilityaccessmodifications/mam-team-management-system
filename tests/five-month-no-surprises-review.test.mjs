import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildCheckInReminderWorkflow,
  FIVE_MONTH_RECORD_PATH,
  TEST_RECIPIENT,
} from '../scripts/build-check-in-reminder-workflow.mjs';

const reminderId = '10000000-0000-4000-8000-000000000005';
const reviewId = '20000000-0000-4000-8000-000000000005';

function nodeMap(workflow) {
  return Object.fromEntries(workflow.nodes.map((node) => [node.name, node]));
}

function reminderPayload(overrides = {}) {
  return {
    version: 1,
    event: 'checkin-reminder',
    mode: 'test',
    deliveryId: 'checkin:' + reminderId + ':5-month:initial:test',
    employee: {
      firstName: 'Taylor',
      lastName: 'Starter',
      role: 'Coordinator',
      department: 'Operations',
      workEmail: 'work@example.test',
      personalEmail: 'personal@example.test',
    },
    manager: { name: 'Morgan Manager', email: 'manager@example.test' },
    milestone: '5-month',
    dueDate: '2027-02-11',
    reminder: 'initial',
    resources: {},
    ...overrides,
  };
}

function reviewPayload(overrides = {}) {
  return {
    version: 1,
    event: 'checkin-review-escalation',
    mode: 'test',
    deliveryId: 'checkin-review:' + reviewId + ':hr:2:test',
    employeeName: 'Taylor Starter',
    managerName: 'Morgan Manager',
    milestone: '5-month',
    reviewDate: '2027-02-11',
    notes: 'Needs <HR> follow-up & support.',
    reviewVersion: 2,
    ...overrides,
  };
}

test('Marketing test workflow hard-routes the 5-Month email and attaches the supplied review from HR', () => {
  const workflow = buildCheckInReminderWorkflow({ mode: 'test' });
  const nodes = nodeMap(workflow);
  const validate = new Function('$input', nodes['Validate Check-In Request'].parameters.jsCode);
  const [result] = validate({ first: () => ({ json: { body: reminderPayload() } }) });
  assert.equal(result.json.valid, true);
  assert.equal(result.json.actualRecipient, TEST_RECIPIENT);
  assert.equal(result.json.deliveryTo, TEST_RECIPIENT);
  assert.equal(result.json.deliveryBcc, '');

  const build = new Function('$input', nodes['Build 5-Month No-Surprises Review Email and Attachment'].parameters.jsCode);
  const [email] = build({ first: () => ({ json: result.json }) });
  assert.equal(email.json.subject, 'Your 5-Month Check-In – Taylor Starter');
  assert.match(email.json.bodyContent, /no surprises at the six-month stage/);
  assert.match(email.json.bodyContent, /contact People &amp; Culture following the meeting/);
  assert.equal(email.binary.record.fileName, '5-Month No-Surprises Review.docx');
  assert.deepEqual(Buffer.from(email.binary.record.data, 'base64'), readFileSync(FIVE_MONTH_RECORD_PATH));
  assert.equal(
    nodes['Send 5-Month No-Surprises Review Email from HR'].credentials.microsoftOutlookOAuth2Api.name,
    'Microsoft Outlook account - hr@mobilityaccess.com.au',
  );
  assert.equal(workflow.settings.saveDataErrorExecution, 'none');
});

test('Live 5-Month workflow sends once to both employee addresses and the direct manager', () => {
  const nodes = nodeMap(buildCheckInReminderWorkflow({ mode: 'live' }));
  const validate = new Function('$input', nodes['Validate Check-In Request'].parameters.jsCode);
  const live = reminderPayload({
    mode: 'live',
    deliveryId: 'checkin:' + reminderId + ':5-month:initial:live',
    employee: {
      ...reminderPayload().employee,
      workEmail: 'WORK@example.test',
      personalEmail: 'personal@example.test',
    },
  });
  const [result] = validate({ first: () => ({ json: { body: live } }) });
  assert.equal(result.json.valid, true);
  assert.equal(result.json.actualRecipient, 'manager@example.test,personal@example.test,work@example.test');
  assert.equal(result.json.deliveryTo, 'manager@example.test,work@example.test');
  assert.equal(result.json.deliveryBcc, 'personal@example.test');

  const send = nodes['Send 5-Month No-Surprises Review Email from HR'];
  assert.equal(send.parameters.toRecipients, '={{ $json.deliveryTo }}');
  assert.equal(send.parameters.additionalFields.bccRecipients, '={{ $json.deliveryBcc }}');
});

test('Live Check-In routing hides personal email from visible recipients and preserves punctuation in subjects', () => {
  const nodes = nodeMap(buildCheckInReminderWorkflow({ mode: 'live' }));
  const validate = new Function('$input', nodes['Validate Check-In Request'].parameters.jsCode);
  const live = reminderPayload({
    mode: 'live',
    deliveryId: 'checkin:' + reminderId + ':5-month:initial:live',
    employee: {
      ...reminderPayload().employee,
      firstName: 'Taylor',
      lastName: "A & O'Connor",
      workEmail: null,
      personalEmail: 'private@example.test',
    },
  });
  const [result] = validate({ first: () => ({ json: { body: live } }) });
  assert.equal(result.json.valid, true);
  assert.equal(result.json.actualRecipient, 'manager@example.test,private@example.test');
  assert.equal(result.json.deliveryTo, 'manager@example.test');
  assert.equal(result.json.deliveryBcc, 'private@example.test');

  const build = new Function('$input', nodes['Build 5-Month No-Surprises Review Email and Attachment'].parameters.jsCode);
  const [email] = build({ first: () => ({ json: result.json }) });
  assert.equal(email.json.subject, "Your 5-Month Check-In – Taylor A & O'Connor");
});

test('5-Month workflow rejects missing employee emails and the legacy final reminder', () => {
  const nodes = nodeMap(buildCheckInReminderWorkflow({ mode: 'test' }));
  const validate = new Function('$input', nodes['Validate Check-In Request'].parameters.jsCode);

  const missingEmail = reminderPayload({
    employee: { ...reminderPayload().employee, workEmail: null, personalEmail: null },
  });
  const [missingEmailResult] = validate({ first: () => ({ json: { body: missingEmail } }) });
  assert.equal(missingEmailResult.json.valid, false);

  const legacyFinal = reminderPayload({
    reminder: 'final',
    deliveryId: 'checkin:' + reminderId + ':5-month:final:test',
  });
  const [legacyFinalResult] = validate({ first: () => ({ json: { body: legacyFinal } }) });
  assert.equal(legacyFinalResult.json.valid, false);
});

test('People & Culture escalation is fixed to marketing in test and HR in live', () => {
  const testNodes = nodeMap(buildCheckInReminderWorkflow({ mode: 'test' }));
  const testValidate = new Function('$input', testNodes['Validate Check-In Request'].parameters.jsCode);
  const [testResult] = testValidate({
    first: () => ({ json: { body: reviewPayload({ recipient: 'attacker@example.test' }) } }),
  });
  assert.equal(testResult.json.valid, true);
  assert.equal(testResult.json.actualRecipient, TEST_RECIPIENT);
  assert.equal(testResult.json.deliveryTo, TEST_RECIPIENT);
  assert.equal(testResult.json.deliveryBcc, '');
  assert.equal(Object.hasOwn(testResult.json, 'recipient'), false);

  const build = new Function('$input', testNodes['Build People & Culture Review Email'].parameters.jsCode);
  const [email] = build({ first: () => ({ json: testResult.json }) });
  assert.equal(email.json.subject, '[MAM] People & Culture review required – Taylor Starter');
  assert.match(email.json.bodyContent, /5-Month No-Surprises Review/);
  assert.match(email.json.bodyContent, /Needs &lt;HR&gt; follow-up &amp; support/);
  assert.equal(
    testNodes['Send People & Culture Review Email from HR'].credentials.microsoftOutlookOAuth2Api.name,
    'Microsoft Outlook account - hr@mobilityaccess.com.au',
  );

  const liveNodes = nodeMap(buildCheckInReminderWorkflow({ mode: 'live' }));
  const liveValidate = new Function('$input', liveNodes['Validate Check-In Request'].parameters.jsCode);
  const [liveResult] = liveValidate({
    first: () => ({
      json: {
        body: reviewPayload({
          mode: 'live',
          deliveryId: 'checkin-review:' + reviewId + ':hr:2:live',
          recipient: 'attacker@example.test',
        }),
      },
    }),
  });
  assert.equal(liveResult.json.valid, true);
  assert.equal(liveResult.json.actualRecipient, 'hr@mobilityaccess.com.au');
  assert.equal(liveResult.json.deliveryTo, 'hr@mobilityaccess.com.au');
  assert.equal(liveResult.json.deliveryBcc, '');
  assert.equal(Object.hasOwn(liveResult.json, 'recipient'), false);
});

test('People & Culture escalation rejects control characters in the email subject name', () => {
  const nodes = nodeMap(buildCheckInReminderWorkflow({ mode: 'live' }));
  const validate = new Function('$input', nodes['Validate Check-In Request'].parameters.jsCode);
  const [result] = validate({
    first: () => ({
      json: {
        body: reviewPayload({
          mode: 'live',
          deliveryId: 'checkin-review:' + reviewId + ':hr:2:live',
          employeeName: 'Taylor\r\nBcc: attacker@example.test',
        }),
      },
    }),
  });

  assert.equal(result.json.valid, false);
  assert.equal(result.json.code, 'invalid_payload');
});
