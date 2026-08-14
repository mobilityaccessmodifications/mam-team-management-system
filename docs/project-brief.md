# Project brief

## Outcome

Give MAM and Equipsy staff one private, minimal Safer People System for the organisation tree, account access, leave visibility and essential people workflows.

## Current phase

- Maintain the private application, company repository, fixed production URL and verified Supabase boundary.
- Use the privately imported real MAM/Equipsy directory as the only selectable people source.
- Give database-authorised HR users a private Directory tab to add and maintain employee details, while keeping the organisation tree limited to safe structural information.
- Provide an HR-only export using the agreed 12-column employee CSV format, without portal-account or credential fields.
- Provide username/password login for directory-linked accounts through Supabase Auth.
- Give the authorised administrator a master view of the real directory and portal-account lifecycle.
- Demonstrate leave submission, manager decisions, overlap visibility, onboarding, offboarding and check-ins with records created in the current browser session.
- Keep Recruitment excluded.

## Account administration boundary

- The administrator can view login names, active/disabled status and last sign-in information.
- The administrator can create an account, rename its login, set a new password and disable or enable it.
- Existing passwords can never be viewed or recovered; Supabase Auth stores only non-reversible password hashes.
- A password returned immediately after create/reset is a one-time handover value. It is not stored in the application database, source, Vercel variables or logs.
- The Supabase secret key is server-only and may be used only after the Server Action verifies the caller's session and database-controlled account-administrator permission.

## HR directory boundary

- The HR Directory is distinct from account administration. It is protected by a database-controlled HR permission, not by an account role chosen in the browser or View-as context.
- Private employee details are one-to-one with a safe organisation person record. The unified editor updates canonical organisation fields so the live organisation tree reflects committed changes through Realtime.
- The organisation tree remains safe: name, position, company and reporting relationship only.
- HR exports retain the agreed 12 employee columns and order, and exclude usernames, Auth aliases and passwords.
- Real workbook data remains outside Git and is staged for reconciliation. It must not automatically replace an identity, deactivate a person or relink an existing portal account.

## Current workflow boundary

- There are no fake profiles, seeded fake leave requests, fake contacts or pre-created People workflow cases.
- Leave and People workflow examples use people from the authenticated real directory.
- Leave requests, decisions, files, onboarding/offboarding cases, task changes, evidence indicators and check-in records exist only in the open browser session and clear on refresh.
- The administrator's View-as control changes presentation context only. It does not impersonate another Auth user or change database permissions.
- Workflow examples do not create accounts, provision/revoke external access, schedule work or send email.
- Durable leave and People workflow data remains subject to approved business rules, RLS, retention, audit and notification designs.

## Not yet in scope

- Payroll or award interpretation.
- Automatic leave approval.
- Writing leave into AroFlo, Outlook calendars, payroll or another production system.
- Live staff email notifications or review-mailbox delivery.
- Exposing leave reasons to coworkers.
- Durable onboarding, offboarding or check-in automation.
- Recruitment automation.

## Definition of done for this increment

- Fake selectable profiles and seeded fake workflow records are removed.
- Every visible person comes from the authenticated Supabase directory.
- The account registry and its RLS/security-definer functions are migrated in the verified MAM production project.
- The existing administrator is linked to the correct real directory person and can manage account lifecycle safely.
- `SUPABASE_SECRET_KEY` exists only in the server environment for the intended Vercel project.
- Account management never exposes an existing password or Auth-internal address.
- The HR Directory protects private employee details with database-controlled HR access, updates the live safe organisation tree from the same canonical record, and exports only the approved employee CSV shape.
- `npm run check` passes and the established production URL is updated.
