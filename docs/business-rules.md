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
- The database-controlled **System Admin** role is an all-module role. Approved System Admin accounts are configured only in the verified production role registry. They may view and administer the full employee directory, accounts, organisation, check-ins, leave and calendar; a browser-selected profile or client state never grants these permissions.
- Employee profiles are archived before permanent deletion. Archiving requires an employment end date and a controlled reason, removes the person from active directory views while retaining history, and is visible only to a System Admin. Legacy inactive roster rows without an archive reason are not archived profiles and do not appear in the Archived filter. Permanent deletion is limited to archived, unlinked, history-free profiles.
- The HR Directory is the unified employee editor. Its committed name, title, company, reporting and start-date changes update the canonical directory and are distributed to authorised sessions through Realtime.
- The live organisation baseline keeps every active Team Leader directly reporting to the MAM Director. Under the Minor Mods Team Leader, five structural groups—Scheduling team, Estimating team, Trades team, Admin team and CSO team—keep the approved Minor Mods reporting view clear. CSO stays empty until HR assigns a confirmed employee; it must never be filled by title inference.
- Employee self-service contact changes update the same private employee-detail record but do not change the public organisation tree, work identity, work email, reporting relationship or account settings.
- The HR CSV preserves the agreed 13 employee columns and field order, with Company immediately after Team, then appends Laptop supplied, Laptop ID, Mouse ID, Keyboard ID and Asset Tags. It excludes portal logins, Auth aliases, existing passwords and any newly issued password.
- MAM uses the orange accent and Equipsy uses blue; company remains visible as text.
- Real roster names and positions are imported privately into the verified production project. They must not be committed to Git, copied into fixtures or used in screenshots.
- A supplied HR workbook must be staged and reconciled with the live directory before import. It does not authorise automatic identity replacement, deactivation or portal-account relinking.
- Every ordinary portal account must link to one active person in the real directory. There are no fake or synthetic selectable profiles or demo roles. **Change profile** lists active real directory people only for a controlled System Admin account.
- The server verifies the signed-in account and its active status before opening the application. The signed-in session and database-controlled role are the only source of access; client-side state never grants permission or impersonates another account. Change profile changes the employee-workspace presentation and manager-safe Check-in Calendar/task scope, while the real System Admin retains independently re-authorised functions for testing (including leave submission, evidence, cancellation, decisions and check-in completion). Every mutation records the real System Admin actor; selecting a profile never grants those permissions to that employee.
- An authorised HR user may view account login names, status and last sign-in time; create a login; change a login name; set a new password; and disable or enable an account.
- No HR user can view or recover an existing password. Supabase Auth stores password hashes, not reversible passwords. A newly generated or supplied password may be shown once after creation/reset and is not retained in application tables or logs.
- The deployed durable leave flow requires every submitted request to start Pending. It has no automatic approval and no self-approval. Approval authority is a separate, private database capability: an active linked profile with the database `manager` role is eligible, and the organisation tree determines which manager receives each request. Job titles and team labels alone never grant approval.
- Every active linked employee may submit their own leave request. The request walks upward through the reporting tree and stops at the nearest active manager profile. An employee who is not a manager does not intercept requests from people below them. Every System Admin may review every request as part of their all-module role.
- At submission, the database snapshots the nearest manager and global reviewers. Still-pending work is re-routed when manager permission changes; decided history is not rewritten. No reviewer, including HR and global reviewers, may decide their own leave request.
- An active linked employee may cancel any of their own leave requests, regardless of leave type, date or current status, unless it is already cancelled. System Admin retains the same capability while using Change Profile. Cancellation is an audited state transition: the request and any previous decision remain in history, and an already cancelled request cannot be cancelled again.
- Employment type is recorded as ABN, Casual, Full Time or Part Time by a System Admin. Full Time and Part Time employees may request Annual, Sick, Carer's or Unpaid leave. ABN and Casual employees have no paid-leave entitlement and may request Unpaid leave only. The database snapshots the employment type and paid/unpaid treatment when each request is submitted; this classification is eligibility, not a leave-balance calculation.
- Every active employee receives an automatic check-in schedule from their start date. Users do not enable reminders or queue catch-up work manually.
- If a check-in milestone due date falls on Saturday or Sunday, it moves forward to the next Monday-to-Friday working day. Reminder lead time is measured from that scheduled workday; if the resulting advance notification date falls on a weekend, it moves back to the previous working day. Due check-in tasks appear in Calendar.
- Every System Admin may view and complete check-ins for all employees. Configured managers receive Check-in access only for their current descendants in the authoritative organisation tree. This scope is based on the controlled active portal-account-to-employee link, not Auth metadata or a job title. An incorrect reporting link can therefore grant the wrong scoped task list and must be treated as an HR data-integrity issue. Manager access never exposes HR private profile fields.
- Check-in reminders due before 1 July 2026 are backfilled as complete and must not generate catch-up work or email.
- Creating an employee in the HR Directory does not create a portal login, invitation or email. HR creates a login separately through the authorised Accounts workflow; automated employee invitations are not available.

## Decisions required before live workflow use

1. Who may submit leave on behalf of another employee?
2. What delegate or fallback procedure applies when a named reviewer is unavailable? Any delegation must be an explicit private approval grant; the application must not infer it from the organisation tree.
3. What overlap information may employees see: names and dates, team totals only, or nothing?
4. Which additional leave categories, if any, are supported and which reasons are private to HR?
5. Are weekends, public holidays, part-time patterns and break deductions calculated automatically?
6. Which systems receive an approved result: Outlook, payroll, AroFlo, Teams or none initially?
7. What is the retention period for rejected/cancelled requests, evidence and event history?
8. What counts as manager-ready versus all-staff-ready?
9. Who may start, view and complete onboarding/offboarding work, including delegated owners and HR-only exit information?
10. Which systems, assets and subscriptions are required for each role, who approves them, and what retention/audit period applies? **Interim implementation pending confirmation/deployment:** only a System Admin receives the full asset and subscription registers (including costs and membership); employees retain their own minimised subscription/device projections, and managers receive no company-wide register until a scoped policy is approved.
11. Should a cross-company reporting-line edit require an additional confirmation?
12. What credential handover and forced-password-change process is required when an administrator creates or resets an account?
13. Penny must identify the authoritative leave-balance source, ownership and calculation rules before the portal shows a leave balance or entitlement.

## Durable leave rollout (deployed)

- Migration `20260817120000_persist_leave_workspace` is applied to the verified MAM production project and the matching authenticated application is deployed. Leave requests and decisions persist through controlled, RLS-protected operations and refresh across authorised accounts.
- The interface offers Annual leave, Sick leave, Carer's leave and Unpaid leave to Full Time and Part Time employees. ABN and Casual employees see and may submit Unpaid leave only. An unclassified employee also fails closed to Unpaid leave until a System Admin records the employment type.
- A request may optionally specify a start time for the first date and an end time for the last date. Times are between 6:00 am and 6:00 pm in fixed 15-minute intervals. Leaving both blank means full working days.
- Weekday duration is calculated inside that working window. Break deductions, standard daily hours, payroll treatment and evidence rules are not final policy.
- Every submitted request starts Pending and must be decided by an authorised reviewer. No request is automatically approved or self-approved. The database resolves the nearest active manager profile in the reporting tree, plus every System Admin, and snapshots that reviewer set at submission. Still-pending work is re-routed when manager permission changes; decided history is not rewritten.
- The calendar can browse months and is limited to availability for leave. An ordinary employee peer sees company availability as **Away**, not another person's leave type, reason, notes or evidence. Managers and HR see only the additional detail their authorised review role requires. The approved birthday exception is shown to every signed-in internal employee across MAM and Equipsy as an active employee's name and recurring day/month only; birth year and all other private profile fields remain hidden.
- A submitted or approved leave request may hold up to ten private PDF or supported image attachments of 5 MB each. Files use opaque paths in the private `leave-evidence` bucket, are downloadable only after a fresh request-level authorisation check, and are always forced downloads. A daily `CRON_SECRET`-protected maintenance route removes abandoned objects after a two-hour grace period, expires upload intents and removes minimal upload-attempt rows after 35 days. This release does not provide malware scanning or quarantine; users are warned not to upload unsafe or unrelated files.
- Authorised leave records and decisions persist and refresh across accounts. A submission or cancellation sends one deduplicated HTML notification to the request's server-resolved nearest active manager/admin; approval or decline sends one to every HR-recorded employee address (Work and Personal, when present), with duplicate addresses removed. Every leave notification CCs `hr@mobilityaccess.com.au`; approved and cancelled leave notifications also CC `accounts@mobilityaccess.com.au`. The browser cannot choose a recipient.

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
- Portal-account passwords are never persisted in application tables, logs, screenshots or source. Existing portal-account passwords are never displayed because Supabase Auth stores only non-reversible hashes.
- Subscription-service credentials are a separate, explicit vault workflow. The vault stores an AES-256-GCM encrypted payload only; plaintext is decrypted only after an authorised user explicitly reveals a single service credential, is never included in a catalogue/export/audit row and is cleared from the page after a short timeout. A System Admin controls the named delegate list; a delegate receives no subscription cost, ownership, member or review data merely by receiving credential access.
- HR employee CSV exports are available only to an authorised HR session and are not stored by the application, committed to Git or used as fixtures.
- The business still needs to confirm the long-term retention/deletion period and whether malware scanning or quarantine is required for medical evidence. Until then, access remains restricted to the employee, authorised reviewer and HR, and unnecessary sensitive evidence should not be collected.
- Onboarding/offboarding evidence, exit information, access records and audit history require role-specific access, retention and deletion rules before durable use.
- Production staff data must not be copied into Development or Preview.
