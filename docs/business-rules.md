# Leave and People operations business rules

## Confirmed

- Safer People System covers MAM and Equipsy.
- Managers and team leads need a shared view of who is away so coverage does not depend on asking around in person.
- The initial release remains a management review before all-staff rollout.
- Nixon owns delivery priority; team-supplied priority is input, not a command.
- Employee and HR information is confidential.
- Every authenticated employee may use the organisation tree. It shows the name, position, company and reporting relationship required to understand the structure, and may reveal only a selected person’s work email.
- Employee contact, employment and equipment-allocation details are held in a private one-to-one HR record. The organisation tree never exposes phone numbers, personal email addresses, dates of birth, laptop/asset records or other private employee fields.
- Every active directory-linked employee may open the top-right self-profile. It may show only that employee’s own phone number, personal email, date of birth and read-only work email; they may update only their own phone number, personal email and date of birth. An actual HR administrator using the sidebar Change view control may instead load one selected real employee through an independently HR-authorised profile path and correct those same three private contact fields. The selected employee never gains HR access, and a non-HR browser cannot use that path.
- Only a database-controlled HR, Super Admin, or approved global reviewer account (currently Todd/HR, Steven and Penny) may view the complete employee list, open or edit an arbitrary private employee profile, access the Accounts view, or export the employee CSV. A browser-selected profile, client state or any former account-administrator permission does not grant access.
- Employee profiles are archived before permanent deletion. Archiving requires an employment end date and a controlled reason, removes the person from active directory views while retaining history, and is visible in the Directory only to Super Admin, HR, Steven and Penny. Legacy inactive roster rows without an archive reason are not archived profiles and do not appear in the Archived filter. Permanent deletion is limited to archived, unlinked, history-free profiles.
- The HR Directory is the unified employee editor. Its committed name, title, company, reporting and start-date changes update the canonical directory and are distributed to authorised sessions through Realtime.
- The live organisation baseline keeps every active Team Leader directly reporting to the MAM Director. Under the Minor Mods Team Leader, five structural groups—Scheduling team, Estimating team, Trades team, Admin team and CSO team—keep the approved Minor Mods reporting view clear. CSO stays empty until HR assigns a confirmed employee; it must never be filled by title inference.
- Employee self-service contact changes update the same private employee-detail record but do not change the public organisation tree, work identity, work email, reporting relationship or account settings.
- The HR CSV preserves the agreed 13 employee columns and field order, with Company immediately after Team, then appends Laptop supplied, Laptop ID, Mouse ID, Keyboard ID and Asset Tags. It excludes portal logins, Auth aliases, existing passwords and any newly issued password.
- MAM uses the orange accent and Equipsy uses blue; company remains visible as text.
- Real roster names and positions are imported privately into the verified production project. They must not be committed to Git, copied into fixtures or used in screenshots.
- A supplied HR workbook must be staged and reconciled with the live directory before import. It does not authorise automatic identity replacement, deactivation or portal-account relinking.
- Every ordinary portal account must link to one active person in the real directory. There are no fake or synthetic selectable profiles or demo roles. **Change profile** lists active real directory people only for the controlled System Admin account.
- The server verifies the signed-in account and its active status before opening the application. The signed-in session and database-controlled role are the only source of access; client-side state never grants permission or impersonates another account. Change profile changes the employee-workspace presentation and data scope, while the real System Admin retains all of its independently re-authorised functions for testing (including leave submission, evidence, cancellation, decisions and check-in completion). Every mutation records the real System Admin actor; selecting a profile never grants those permissions to that employee.
- An authorised HR user may view account login names, status and last sign-in time; create a login; change a login name; set a new password; and disable or enable an account.
- No HR user can view or recover an existing password. Supabase Auth stores password hashes, not reversible passwords. A newly generated or supplied password may be shown once after creation/reset and is not retained in application tables or logs.
- The deployed durable leave flow requires every submitted request to start Pending. It has no automatic approval and no self-approval. Approval authority is a separate, private database capability: it is granted explicitly and is never inferred from a title or reporting line.
- Every active linked employee may submit their own leave request. The approved team routes are Major Modifications to Sujant, Minor Modifications to Serene and Warehouse to Kieran. HR, Penny and Steven are global leave reviewers for every request; this leave-review capability does not confer HR Directory or account-administration access.
- At submission, the database resolves the active explicit grants and snapshots the authorised reviewers onto that request. Later changes to a person's team or the organisation tree do not change the reviewer set for an existing request. An explicit grant revocation intentionally removes that reviewer’s access and must be followed by an authorised reassignment for affected pending work. An organisation-subtree grant is a future explicit capability only; the tree itself grants no approval authority. No reviewer, including HR and global reviewers, may decide their own leave request.
- Every active employee receives an automatic check-in schedule from their start date. Users do not enable reminders or queue catch-up work manually.
- If a check-in milestone due date falls on Saturday or Sunday, it moves forward to the next Monday-to-Friday working day. Reminder lead time is measured from that scheduled workday; if the resulting advance notification date falls on a weekend, it moves back to the previous working day. Due check-in tasks appear in Calendar.
- Todd/HR, Penny and Steven may view and complete check-ins for all employees. Any active person with active descendants in the authoritative organisation tree receives manager check-in access only for those current descendants (including Kieran, Sujant and Serene in the current structure). An incorrect reporting link can therefore grant the wrong scoped task list and must be treated as an HR data-integrity issue. Manager access never exposes HR private profile fields.
- Check-in reminders due before 1 July 2026 are backfilled as complete and must not generate catch-up work or email.
- Creating an employee in the HR Directory does not create a portal login, invitation or email. HR creates a login separately through the authorised Accounts workflow; automated employee invitations are not available.

## Decisions required before live workflow use

1. Who may submit leave on behalf of another employee?
2. What delegate or fallback procedure applies when a named reviewer is unavailable? Any delegation must be an explicit private approval grant; the application must not infer it from the organisation tree.
3. What overlap information may employees see: names and dates, team totals only, or nothing?
4. Which leave categories are supported and which reasons are private to HR?
5. Can an employee edit or cancel after submission or approval?
6. Are weekends, public holidays, part-time patterns and break deductions calculated automatically?
7. Which systems receive an approved result: Outlook, payroll, AroFlo, Teams or none initially?
8. What is the retention period for rejected/cancelled requests, evidence and event history?
9. What counts as manager-ready versus all-staff-ready?
10. Who may start, view and complete onboarding/offboarding work, including delegated owners and HR-only exit information?
11. Which systems, assets and subscriptions are required for each role, who approves them, and what retention/audit period applies?
12. Should a cross-company reporting-line edit require an additional confirmation?
13. What credential handover and forced-password-change process is required when an administrator creates or resets an account?
14. Penny must identify the authoritative leave-balance source, ownership and calculation rules before the portal shows a leave balance or entitlement.

## Durable leave rollout (deployed)

- Migration `20260817120000_persist_leave_workspace` is applied to the verified MAM production project and the matching authenticated application is deployed. Leave requests and decisions persist through controlled, RLS-protected operations and refresh across authorised accounts.
- The interface offers Annual leave, Sick leave, Carer's leave and Unpaid leave.
- A request may optionally specify a start time for the first date and an end time for the last date. Times are between 6:00 am and 6:00 pm in fixed 15-minute intervals. Leaving both blank means full working days.
- Weekday duration is calculated inside that working window. Break deductions, standard daily hours, payroll treatment and evidence rules are not final policy.
- Every submitted request starts Pending and must be decided by an authorised reviewer. No request is automatically approved or self-approved. The database resolves only the approved private grants—Major Modifications to Sujant, Minor Modifications to Serene, Warehouse to Kieran, plus global HR, Penny and Steven—and snapshots that reviewer set at submission. Later organisational changes cannot silently reroute an existing request.
- The calendar can browse months and is limited to availability for leave. An ordinary employee peer sees company availability as **Away**, not another person's leave type, reason, notes or evidence. Managers and HR see only the additional detail their authorised review role requires. The approved birthday exception is shown to every signed-in internal employee across MAM and Equipsy as an active employee's name and recurring day/month only; birth year and all other private profile fields remain hidden.
- A submitted or approved leave request may hold up to ten private PDF or supported image attachments of 5 MB each. Files use opaque paths in the private `leave-evidence` bucket, are downloadable only after a fresh request-level authorisation check, and are always forced downloads. A daily `CRON_SECRET`-protected maintenance route removes abandoned objects after a two-hour grace period, expires upload intents and removes minimal upload-attempt rows after 35 days. This release does not provide malware scanning or quarantine; users are warned not to upload unsafe or unrelated files.
- Authorised leave records and decisions persist and refresh across accounts. During the marketing test phase, a leave submission sends one deduplicated HTML notification to the request's server-resolved assigned manager through the MAM n8n receiver. Approval, decline and cancellation events remain routed to `marketing@mobilityaccess.com.au` for HR testing. The browser cannot choose a recipient, and no employee, CC or BCC delivery is enabled.

## People workflow boundaries

- Recruitment is excluded.
- Check-ins are durable and automatic for active employees. Their due tasks are visible in Calendar only to the authorised global or organisation-subtree reviewers described above.
- Onboarding and offboarding review work must not expose private evidence, HR notes, access details or audit history outside its authorised scope.
- No People workflow action creates a login or provisions or revokes external access.
- An offboarding case is labelled and displayed as offboarding, never onboarding.

## Data minimisation

- The team calendar shows only what is required for coverage: company availability for ordinary employee peers, represented as **Away**. It is not a leave-balance ledger. Birthdays remain name plus recurring month/day only; check-in tasks are a separate entry type visible only within the confirmed reviewer scope.
- Organisation cards show only safe structural information. A selected person may expose their work email; phone number, personal email, date of birth, payroll, leave-reason, medical, work-location and hardware-allocation data never belongs in the employee-visible tree.
- The top-right self-profile is the sole employee self-service private-contact exception: it is scoped to the signed-in employee’s own record. A separate HR-only selected-profile path may show and correct one selected employee’s contact fields after the HR capability is rechecked.
- Detailed leave types, reasons, notes and evidence do not appear in the shared calendar.
- Login pages and account lists do not expose internal Auth email aliases.
- Password values are never persisted in application tables, logs, screenshots or source. Existing passwords are never displayed.
- HR employee CSV exports are available only to an authorised HR session and are not stored by the application, committed to Git or used as fixtures.
- The business still needs to confirm the long-term retention/deletion period and whether malware scanning or quarantine is required for medical evidence. Until then, access remains restricted to the employee, authorised reviewer and HR, and unnecessary sensitive evidence should not be collected.
- Onboarding/offboarding evidence, exit information, access records and audit history require role-specific access, retention and deletion rules before durable use.
- Production staff data must not be copied into Development or Preview.
