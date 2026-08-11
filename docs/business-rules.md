# Leave and People operations business rules

## Confirmed

- Managers and team leads need a shared view of who is away so coverage does not depend on asking around in person.
- The initial release is for management review before any all-staff rollout.
- Nixon owns the delivery priority; a team-supplied priority is input, not a command.
- Employee and HR data is confidential.
- Employee requests still require a final manager decision; the system does not automatically approve them in Phase 1.

## Decisions required before live use

1. Who may submit leave: employee, manager on behalf of an employee, or both?
2. Who approves each team, and who acts when the manager is away?
3. What overlap information can employees see: names and dates, team totals only, or nothing?
4. Which leave categories are supported and which reasons are private to HR?
5. Can an employee edit or cancel after submission or approval?
6. Are weekends, public holidays and part-time work patterns calculated automatically?
7. Which systems receive the approved result: Outlook, payroll, AroFlo, Teams, or none initially?
8. What is the retention period for rejected/cancelled requests and event history?
9. What counts as manager-ready versus all-staff-ready?
10. Which exact email domain(s) may sign in?
11. Who may start, view and complete onboarding/offboarding work, including delegated owners and HR-only exit information?
12. Which systems, assets and subscription approvals are required for each role, who approves them, and what retention/audit period applies?
13. Should the live check-in cadence follow the dedicated 2-week/1-month/3-month/5-month schedule or the older checklist's 2-week/3-month/6-month references?

## Demo behaviour — not final payroll policy

- The synthetic demo offers Annual leave, Sick leave, Carer's leave and Unpaid leave.
- A timed request can optionally specify a start time for the first date and an end time for the last date, both between 6:00 am and 6:00 pm in fixed 15-minute intervals. Leaving both times blank means full working days.
- The demo totals weekday hours inside the 6:00 am–6:00 pm working window. Break deductions, standard daily hours, payroll treatment and evidence requirements still need confirmation before live use.
- Manager review shows a calendar from three weeks before the requested start through three weeks after the requested end, rounded to full Monday-to-Sunday weeks. The applicant is highlighted, relevant team leave and public holidays are visible, and another employee's private reason is never shown.
- Employee requests are pending until their assigned manager decides them. A manager's own leave is added directly as an approved calendar record with approval marked “Not required”; managers never approve themselves. “To approve” includes only pending employee requests assigned to the selected manager.
- The synthetic demo previews an email to the assigned Team Leader after an employee request, an email to the employee after a decline, and emails to the employee, HR and Accounts after approval. The Team Leader preview contains a direct in-app review link. No email is sent and no recipient address is stored.
- The employee, Team Leader and HR previews can show the request reason. Accounts receives only the employee, leave type, dates/times and approval status; the reason and supporting files remain private until a live recipient policy is approved.
- A request may include up to three supporting PDF or image files, limited to 5 MB each. In the current no-login demo, files remain only in the open browser session and appear only in manager or HR views. The authenticated release uses a private Supabase Storage bucket and RLS so employees and coworkers cannot download evidence after submission.
- Shared demo mode stores only the fixed synthetic dataset. The profile selector simulates roles and is not evidence of user identity or authorization.

## People operations demo behaviour — not live HR automation

- Recruitment is not part of this module or demo.
- The People workspace demonstrates synthetic onboarding and offboarding cases with checklist groups, role-assigned tasks, `Not Started`, `In Progress`, `Complete` and `Overdue` statuses, an illustrative asset/access register and a short audit trail. A workflow reaches “Ready for Day 1” or “Offboarding complete” only when every task in the underlying checklist is complete.
- HR may manage any synthetic case. A simulated Team Leader may confirm that manager-owned task for their assigned employee, and a simulated employee may confirm their own employee-owned task. These visibility rules are a UI demonstration, not authentication or authorisation.
- An employee sees only their own check-ins and, when one is active, a single lifecycle tab: My onboarding or Offboarding. The tab exposes only Employee-owned actions; employees without an active lifecycle workflow see no lifecycle tab, and no employee can see another employee's offboarding. HR, IT, manager, asset, access and audit details remain hidden from employee views. This is a privacy-oriented demo convention, not a live authorisation policy.
- A selected PDF/image confirmation is represented by a private attachment indicator in browser state. Cases, evidence selections/uploads, asset/access changes and audit entries are cleared on refresh or Reset demo; nothing is written to Supabase and no account, licence, asset, or external system is actually provisioned or revoked.
- The Check-ins tab keeps a synthetic register and creates check-ins at 2 weeks, 1 month, 3 months and 5-month probation from the start date. Manager prompts are scheduled 3 days before the 2-week check-in, 4 business days before the 1-month check-in, 2 weeks before the 3-month check-in, and 2 weeks plus a final 1 week before the 5-month check-in.
- The dedicated automated-check-in requirement is used in the demo because it is newer and more specific than the older onboarding checklist. The final live cadence, forms/templates, recipients, business-day calendar and snooze/escalation rules still require confirmation.
- “Run reminder preview” adds an in-app synthetic Team Leader email preview and can mark a reminder previewed, complete or snoozed. It does not schedule work, call an email provider, retain recipient addresses or send email.
- The People workspace's My profile panel derives a selected synthetic profile's tenure from a fixed demo start date and can show a subtle anniversary treatment. Its manager, People and IT contact details use `example.test`; it does not contain real employee contact details or form a security boundary.

## Data minimisation

- The team calendar should show only what is required for coverage.
- Detailed reasons and attachments must not appear in the shared calendar.
- Medical certificates and other evidence require an agreed retention/deletion period and malware-scanning decision before live staff use.
- Onboarding/offboarding documents, exit information, employee contact details, access records and audit history require role-specific access, retention and deletion rules before live staff use.
- Use synthetic names and dates in development, CI, screenshots and demos.
