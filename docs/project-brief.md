# Project brief

## Outcome

Give MAM and Equipsy staff one private, minimal Safer People System for the organisation tree, account access, leave visibility and essential people workflows.

## Current phase

- Maintain the private application, company repository, fixed production URL and verified Supabase boundary.
- Use the privately imported real MAM/Equipsy directory as the only selectable people source.
- Give database-authorised HR users a private Directory tab to add and maintain employee details, while keeping the organisation tree limited to safe structural information.
- Give every active directory-linked employee a top-right self-profile for their own phone number, personal email and date of birth, with work email shown read-only and HR-managed; allow actual HR administrators to load the selected real employee’s same contact profile through Change view.
- Provide an HR-only export that preserves the agreed 13 employee columns, with Company immediately after Team, then adds the HR-only Laptop supplied, Laptop ID, Mouse ID, Keyboard ID and Asset Tags audit columns without portal-account or credential fields.
- Provide username/password login for directory-linked accounts through Supabase Auth.
- Give the authorised administrator a master view of the real directory and portal-account lifecycle.
- Maintain durable leave and automatic employee check-ins. Keep onboarding and offboarding as separate review work.
- Keep Recruitment excluded.

## Account administration boundary

- The administrator can view login names, active/disabled status and last sign-in information.
- The administrator can create an account, rename its login, set a new password and disable or enable it.
- Existing passwords can never be viewed or recovered; Supabase Auth stores only non-reversible password hashes.
- A password returned immediately after create/reset is a one-time handover value. It is not stored in the application database, source, Vercel variables or logs.
- The Supabase secret key is server-only and may be used only after the Server Action verifies the caller's session and database-controlled account-administrator permission.
- Creating an employee Directory record does not create a login, send an invitation or send an email. HR creates the portal login separately through Accounts; automated invites are not in scope.

## HR directory boundary

- The HR Directory is distinct from account administration. It is protected by a database-controlled HR permission, not by an account role chosen in the browser or View-as context.
- Private employee details are one-to-one with a safe organisation person record. The unified editor updates canonical organisation fields so the live organisation tree reflects committed changes through Realtime.
- The self-profile is not an HR Directory: self-service derives the signed-in linked person on the server and can update only that person’s phone number, personal email and date of birth. The HR-selected profile uses a distinct, HR-authorised server/database path for one selected real employee and has the same limited editable fields. It shows work email as read-only and never exposes a private roster to non-HR users.
- The organisation tree remains safe: name, position, company and reporting relationship only.
- HR exports retain the agreed 13 employee columns and order, with Company immediately after Team, then append Laptop supplied, Laptop ID, Mouse ID, Keyboard ID and Asset Tags. They exclude usernames, Auth aliases and passwords.
- Real workbook data remains outside Git and is staged for reconciliation. It must not automatically replace an identity, deactivate a person or relink an existing portal account.

## Current workflow boundary

- There are no fake profiles, seeded fake leave requests, fake contacts or pre-created People workflow cases.
- Leave and People workflows use people from the authenticated real directory.
- Leave requests, decisions and employee check-ins persist through controlled, RLS-protected operations.
- Migrations `20260817120000_persist_leave_workspace` and `20260818130000_configurable_leave_approval_grants` are applied to verified MAM production and the matching application is deployed. Every active linked employee may submit their own request; every request starts Pending, with no automatic or self-approval. The approved private approval-grant policy routes Major Modifications to Sujant, Minor Modifications to Serene and Warehouse to Kieran, while HR, Penny and Steven are global reviewers. The reviewer set is snapshotted at submission, and an organisation-tree change does not alter an existing request. An explicit grant revocation removes the reviewer’s access and needs an authorised pending-work reassignment. Subtree review is an explicit future grant, not an automatically inferred tree permission.
- The leave calendar is not a balance ledger. Ordinary employees see only their own leave, Check-in dates and birthday; another employee's leave and birthday are omitted. Managers additionally see their own and active reporting descendants' birthdays. Explicit Accounts/Bookkeeping Approved-leave viewers receive current and archived employees' names, dates, exact schedule and duration needed for payroll processing with a generic **Approved leave** category; archived names carry an `(archived)` suffix, while the other employee's leave type, reason, notes, evidence and balance remain excluded. Birthday markers contain only a name and recurring day/month—never birth year or contact data.
- Supporting PDFs and supported images are stored in a private, request-authorised bucket with bounded upload limits, forced downloads and daily orphan/metadata cleanup. Malware scanning and the final medical-evidence retention policy remain explicit operational limitations.
- The System Admin's Change profile control changes presentation and selected-employee workflow context without impersonating another Auth user. The real System Admin keeps its full database-authorised functions and remains the audit actor for every test mutation.
- Active employee check-ins are scheduled automatically from start date. Weekend and published Victorian public-holiday milestone due dates move forward to the next Victorian business day; reminder lead time is calculated from that scheduled workday, and any resulting weekend or public-holiday notification moves back to the previous Victorian business day. Due tasks appear in Calendar.
- Released 2-Week, 1-Month and 2-Month emails run three business days before their Check-In; 3-Month and 5-Month emails run five business days before. They are sent from HR to the employee's available Work/Personal addresses and Direct Manager with the relevant record attached; Personal addresses use BCC. Selecting the HR review pathway queues a durable People & Culture alert.
- Todd/HR, Penny and Steven see all employee check-ins. Kieran, Sujant and Serene see only current organisation-tree descendants, without HR private profile fields. Manual enable and catch-up queue controls are not part of the workflow.
- Reminders due before 1 July 2026 are backfilled complete. Current reminder delivery uses the approved automated manager-email route.
- People workflows do not create accounts or provision/revoke external access.

## Not yet in scope

- Payroll or award interpretation.
- Automatic leave approval.
- Writing leave into AroFlo, Outlook calendars, payroll or another production system.
- Staff notification routes other than the approved Check-In employee/manager reminders and People & Culture review alert.
- Exposing leave reasons to coworkers.
- Durable onboarding or offboarding automation.
- Recruitment automation.

## Definition of done for this increment

- Fake selectable profiles and seeded fake workflow records are removed.
- Every visible person comes from the authenticated Supabase directory.
- The account registry and its RLS/security-definer functions are migrated in the verified MAM production project.
- The existing administrator is linked to the correct real directory person and can manage account lifecycle safely.
- `SUPABASE_SECRET_KEY` exists only in the server environment for the intended Vercel project.
- Account management never exposes an existing password or Auth-internal address.
- The HR Directory protects private employee details with database-controlled HR access, updates the live safe organisation tree from the same canonical record, and exports only the approved employee CSV shape.
- The top-right self-profile lets an active linked employee maintain only their own phone number, personal email and date of birth; actual HR administrators may maintain those same fields for a selected employee. Work email remains read-only and HR-managed.
- The durable leave migration `20260817120000_persist_leave_workspace` is applied in the MAM production project and the matching release is deployed; future changes must continue to demonstrate persistence/refresh across authorised accounts, Pending-only submission, no self-approval, authorised review, omitted peer leave/birthdays for employees, Manager reporting-subtree birthday scope, and the birthday calendar's name + recurring day/month-only privacy contract.
- The private approval-grant policy must retain the approved team/global routes, no-self-approval boundary and submission-time reviewer snapshots; delegation or subtree review may be added only as an explicit grant. Penny's leave-balance source must be confirmed before any balance or entitlement feature is implemented.
- Check-ins are automatically scheduled for active employees, with weekend due dates moved forward and weekend advance notifications moved back to a working day. They are displayed in Calendar within the confirmed reviewer scope and keep manager views free of HR-private profile fields. Pre-1-July-2026 reminders are complete.
- `npm run check` passes and the established production URL is updated.
