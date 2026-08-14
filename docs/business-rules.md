# Leave and People operations business rules

## Confirmed

- Safer People System covers MAM and Equipsy.
- Managers and team leads need a shared view of who is away so coverage does not depend on asking around in person.
- The initial release remains a management review before all-staff rollout.
- Nixon owns delivery priority; team-supplied priority is input, not a command.
- Employee and HR information is confidential.
- Every authenticated employee may use the organisation tree. It shows the name, position, company and reporting relationship required to understand the structure, and may reveal only a selected person’s work email.
- Employee contact and employment details are held in a private one-to-one HR record. The organisation tree never exposes phone numbers, personal email addresses, dates of birth or other private employee fields.
- Every active directory-linked employee may open the top-right self-profile. It may show only that employee’s own phone number, personal email, date of birth and read-only work email; they may update only their own phone number, personal email and date of birth. An actual HR administrator using the sidebar Change view control may instead load one selected real employee through an independently HR-authorised profile path and correct those same three private contact fields. The selected employee never gains HR access, and a non-HR browser cannot use that path.
- Only a database-controlled HR role may view the complete employee list, open or edit an arbitrary private employee profile, access the Accounts view, or export the employee CSV. A browser-selected profile, client state or any former account-administrator permission does not grant HR access.
- The HR Directory is the unified employee editor. Its committed name, title, company, reporting and start-date changes update the canonical directory and are distributed to authorised sessions through Realtime.
- Employee self-service contact changes update the same private employee-detail record but do not change the public organisation tree, work identity, work email, reporting relationship or account settings.
- The HR CSV uses the agreed 12 employee columns and field order. It excludes portal logins, Auth aliases, existing passwords and any newly issued password.
- MAM uses the orange accent and Equipsy uses blue; company remains visible as text.
- Real roster names and positions are imported privately into the verified production project. They must not be committed to Git, copied into fixtures or used in screenshots.
- A supplied HR workbook must be staged and reconciled with the live directory before import. It does not authorise automatic identity replacement, deactivation or portal-account relinking.
- Every portal account must link to one active person in the real directory. There are no fake or synthetic selectable profiles or demo roles. An explicitly labelled Change view selector may list active real directory people only for a signed-in system administrator who also has the database-controlled HR capability.
- The server verifies the signed-in account and its active status before opening the application. The signed-in session and database-controlled role are the only source of access; client-side state never grants permission or impersonates another account. Change view changes employee-workspace presentation only: it is never an HR presentation; it shows an employee's own leave/workflow context or a real manager's own and approvable context, hides private leave notes/evidence and HR tools, and cannot perform a workspace mutation. The sole exception is the separate HR-authorised top-right contact editor for the selected person.
- An authorised HR user may view account login names, status and last sign-in time; create a login; change a login name; set a new password; and disable or enable an account.
- No HR user can view or recover an existing password. Supabase Auth stores password hashes, not reversible passwords. A newly generated or supplied password may be shown once after creation/reset and is not retained in application tables or logs.
- Employee leave requests require their assigned manager's decision. A manager's own leave does not require self-approval.

## Decisions required before live workflow use

1. Who may submit leave on behalf of another employee?
2. Who approves each team, and who acts when the manager is away?
3. What overlap information may employees see: names and dates, team totals only, or nothing?
4. Which leave categories are supported and which reasons are private to HR?
5. Can an employee edit or cancel after submission or approval?
6. Are weekends, public holidays, part-time patterns and break deductions calculated automatically?
7. Which systems receive an approved result: Outlook, payroll, AroFlo, Teams or none initially?
8. What is the retention period for rejected/cancelled requests, evidence and event history?
9. What counts as manager-ready versus all-staff-ready?
10. Who may start, view and complete onboarding/offboarding work, including delegated owners and HR-only exit information?
11. Which systems, assets and subscriptions are required for each role, who approves them, and what retention/audit period applies?
12. What is the final check-in cadence, form, recipient, business-day calendar and escalation policy?
13. Should a cross-company reporting-line edit require an additional confirmation?
14. What credential handover and forced-password-change process is required when an administrator creates or resets an account?

## Current leave demonstration

- The interface offers Annual leave, Sick leave, Carer's leave and Unpaid leave.
- A request may optionally specify a start time for the first date and an end time for the last date. Times are between 6:00 am and 6:00 pm in fixed 15-minute intervals. Leaving both blank means full working days.
- Weekday duration is calculated inside that working window. Break deductions, standard daily hours, payroll treatment and evidence rules are not final policy.
- Manager review shows a calendar from three weeks before the requested start through three weeks after the requested end, rounded to full Monday-to-Sunday weeks. The applicant is highlighted; relevant team leave may be shown; another person's private reason is not.
- Employee requests start pending and are assigned to the manager derived from the real directory. Managers add their own leave as approved with approval marked “Not required”. “To approve” includes only pending requests assigned to the selected manager.
- A request may include up to three supporting PDF or image files, limited to 5 MB each. Files remain only in the open browser session and are visible only in the applicable manager/HR review context.
- Requests, decisions and supporting files are browser-session examples based on real directory people. Refreshing clears them. They are not production leave records and no notification email is sent.

## Current People workflow demonstration

- Recruitment is excluded.
- Onboarding, offboarding and check-in views start with no pre-seeded cases, reminders, contacts or people.
- An authorised reviewer may create a workflow example for a person from the real directory. Checklist task changes, evidence indicators, asset/access examples and audit activity remain in the open browser session only.
- An employee context exposes only that person's own applicable lifecycle and check-in content. It must not expose another employee's offboarding, private evidence, HR notes, access details or audit history.
- No workflow action creates a login, provisions or revokes access, schedules a reminder, sends an email or writes to Supabase.
- An offboarding case is labelled and displayed as offboarding, never onboarding.

## Data minimisation

- The team calendar shows only what is required for coverage.
- Organisation cards show only safe structural information. A selected person may expose their work email; phone number, personal email, date of birth, payroll, leave-reason, medical and work-location data never belongs in the employee-visible tree.
- The top-right self-profile is the sole employee self-service private-contact exception: it is scoped to the signed-in employee’s own record. A separate HR-only selected-profile path may show and correct one selected employee’s contact fields after the HR capability is rechecked.
- Detailed reasons and evidence do not appear in the shared calendar.
- Login pages and account lists do not expose internal Auth email aliases.
- Password values are never persisted in application tables, logs, screenshots or source. Existing passwords are never displayed.
- HR employee CSV exports are available only to an authorised HR session and are not stored by the application, committed to Git or used as fixtures.
- Medical evidence requires an approved retention/deletion period and malware-scanning decision before durable use.
- Onboarding/offboarding evidence, exit information, access records and audit history require role-specific access, retention and deletion rules before durable use.
- Production staff data must not be copied into Development or Preview.
