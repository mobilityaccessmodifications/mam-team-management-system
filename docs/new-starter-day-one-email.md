# Day 1 new-starter email

People Hub schedules one welcome email one published Victorian business day before an active employee's commencement date. The schedule is created from the existing **Add employee** fields: start date, direct manager, role, company, work email and personal email.

## Recipients and sender

- The first welcome email includes both the employee work email and personal email when both are recorded. Duplicate addresses are collapsed.
- At least one employee email is required for a new active employee.
- The direct manager's work email is included. A direct manager and start date are required for a new active employee.
- n8n sends from the stored `ai@mobilityaccess.com.au` Outlook credential.
- The attached file is `assets/checklists/Day 1 New Starter Readiness Checklist.docx`.

These recipient rules apply only to this first Day 1 message. Existing Check-In reminders keep their current manager/HR routing.

## Test boundary

The generated test workflow accepts only `mode: test` payloads and hard-routes the final Outlook recipient to `marketing@mobilityaccess.com.au`. It does not use employee or manager addresses. Test and live deliveries have distinct durable receipt keys.

The application worker is disabled unless `NEW_STARTER_DAY_ONE_EMAIL_MODE` is an explicit enabled value. `marketing-test` sends the `test` contract to the hard-routed Marketing workflow, while `live` sends the real-recipient contract to the reviewed live workflow. Test and live deliveries use separate durable receipt keys. Promoting the workflow requires a reviewed live workflow, the `N8N_NEW_STARTER_WEBHOOK_ORIGIN` and `N8N_NEW_STARTER_WEBHOOK_URL` Production values, the existing Check-In webhook secret, and a separate change of the mode variable from `marketing-test` to `live`.

## Reliability

`private.employee_new_starter_day_one_reminders` stores only schedule and delivery state; email addresses and message bodies are resolved at claim time and are not copied into the queue. Directory triggers reschedule future starters when the employee, manager, start date or email details change. Missing data is surfaced as `needs_review`.

The worker uses a database claim token, bounded retries and the shared durable provider-receipt service. An independent GitHub Actions recovery scheduler calls the same worker every 15 minutes. Ambiguous provider outcomes do not create permission to send again: the durable receipt gate returns a duplicate acknowledgement or a reconciliation-required rejection. Delivery stops once the commencement date begins.

## Email copy

Subject: **Welcome to MAM/Equipsy – Your First Day**

The message welcomes the employee, names their role, explains the Day 1 topics, asks the direct manager to complete the attached checklist by the end of the first day, and signs off as **HR Manager**.
