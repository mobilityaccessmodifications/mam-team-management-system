import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCheckInReminderWorkflow } from '../scripts/build-check-in-reminder-workflow.mjs';
import { buildNewStarterDayOneWorkflow } from '../scripts/build-new-starter-day-one-workflow.mjs';

for (const mode of ['test', 'live']) {
  for (const [name, build, expectedSenders] of [
    ['Check-In', buildCheckInReminderWorkflow, 8],
    ['Day 1', buildNewStarterDayOneWorkflow, 1],
  ]) {
    test(`${name} ${mode} Outlook senders omit empty BCC recipients and preserve private addresses`, () => {
      const senders = build({ mode }).nodes.filter(node => node.type === 'n8n-nodes-base.microsoftOutlook');
      assert.equal(senders.length, expectedSenders);
      for (const sender of senders) {
        const expression = sender.parameters.additionalFields.bccRecipients;
        const evaluate = new Function('$json', `return (${expression.slice(3, -2)});`);
        for (const value of ['', undefined, '   ', ', ,']) {
          assert.deepEqual(evaluate({ deliveryBcc: value }), []);
        }
        const recipients = evaluate({ deliveryBcc: ' personal@example.test, other@example.test, ' });
        assert.deepEqual(recipients, ['personal@example.test', 'other@example.test']);
        assert.equal(sender.parameters.toRecipients, '={{ $json.deliveryTo }}');
        assert.equal(sender.parameters.additionalFields.saveToSentItems, true);
        assert.equal(sender.retryOnFail, undefined);
      }
    });
  }
}
