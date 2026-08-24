# Architecture

## System boundary

```text
Browser
  -> Vercel / Next.js
       -> Supabase Auth session (username resolved server-side)
       -> RLS-protected organisation-tree DTO (publishable key; selected work email only)
       -> authenticated self-profile Server Actions
            -> controlled own-record database functions
            -> own phone, personal email and date of birth; read-only work email
       -> HR-authorised employee-directory Server Actions and CSV route
            -> controlled database functions
            -> private employee-detail records
       -> HR-authorised account-management Server Actions
            -> server-only Supabase secret key
            -> Supabase Auth Admin API
       -> deployed authenticated leave Server Actions
            -> controlled leave RPCs, RLS and Realtime invalidation
            -> private approval grants and per-request reviewer snapshots
            -> durable leave records in production after migration `20260817120000_persist_leave_workspace`
       -> authenticated check-in Server Actions and Calendar DTO
            -> automatic milestone/reminder schedule and controlled email delivery
            -> global and organisation-subtree access without HR private fields
       -> browser-session onboarding/offboarding review state
```

There is no payroll, AroFlo or provisioning write integration. Check-in manager reminder email is the only automated outbound People workflow described here.

## Authenticated directory

- Safer People System covers MAM and Equipsy. Directory rows contain only the name, position, company, reporting parent and ordering metadata required for the live tree.
- The approved roster is imported privately into the verified Supabase project. Real staff rows are not committed in migrations, fixtures, tests or screenshots.
- MAM uses an orange accent and Equipsy uses blue. Company is also rendered in text.
- Next.js verifies the current Auth session and loads its active portal-account link before rendering the application.
- Database membership, controlled administrator records and RLS are the authorisation boundary. User-editable metadata and client state are never accepted as permission claims.
- Every authenticated employee may use the organisation tree. It exposes name, position, company and reporting relationships; a narrow controlled DTO may additionally return only the selected person’s work email. It never returns phone numbers, personal email addresses, dates of birth or other private employee details.
- Every active directory-linked employee may open the top-right self-profile control. Its narrow server-side DTO is derived from the current Auth session, not a person ID supplied by the browser. It shows that employee’s own phone, personal email and date of birth alongside a read-only HR-managed work email. A separate HR-only selected-profile DTO may be used after an authorised HR administrator chooses a real person from Change view; it is not callable by ordinary employees and its write path remains limited to the same three contact fields.
- An HR-authorised **Directory** tab is the unified employee editor. It writes the canonical organisation name, title, company, reporting fields and start date together with the person’s private HR detail record. Database functions reject invalid or cyclic reporting relationships, and Realtime distributes committed structural changes to other authorised sessions.
- The current production tree also contains public-safe structural `org_unit` nodes for Minor Mods: Scheduling team, Estimating team, Trades team, Admin team and CSO team beneath the Minor Mods Team Leader. They contain no private HR information; the empty CSO team is an intentional structural placeholder until HR confirms an assignment.
- A supplied HR workbook is staged and reconciled against the live directory before import. Matching is never used to automatically replace identities, deactivate people or relink portal accounts.
- There are no demo roles or fake selectable profiles. The controlled System Admin may use **Change profile**, backed only by active real directory people, to select an employee or manager workflow context. It never impersonates an Auth user or grants a capability to the selected employee: each read and mutation is re-authorised against the real System Admin session, and the real System Admin remains the audit actor. Its existing functions remain available so restricted workflows can be tested end to end.

## Portal accounts

`profiles` is the account registry linked one-to-one to Supabase Auth and to a real directory person. It stores the normalised login name, controlled application role, active/disabled state, password-change metadata, credential validity cutoff and optimistic account version. Private HR-authorisation and audit tables control who may manage accounts and record mutations without recording password values.

Normal login is deliberately username-based. The login Server Action resolves the username to an opaque internal Auth address using the server-only client, then asks Supabase Auth to verify the supplied password. The opaque address is not exposed as a staff contact address.

Account-management Server Actions always:

1. verify the caller's Auth session;
2. ask the database whether that caller has the HR authority to manage portal accounts;
3. validate identifiers, login names, passwords and optimistic versions;
4. perform the minimum required Supabase Auth Admin operation; and
5. record the account state through controlled database functions.

Only an authorised HR browser receives the account-management DTO: directory identity, login name, account status, last sign-in time and account version. Existing passwords can never be returned because Supabase Auth stores non-reversible hashes. Creating an account or resetting a password may return the newly supplied value once to HR; it is not persisted in application tables or logs.

Creating an HR Directory record is deliberately separate from creating a portal account. It creates no Auth user, invitation or email. HR must create the login separately through the authorised Accounts path and complete the credential handover under the approved process. There is no automated employee-invite or email workflow.

`SUPABASE_SECRET_KEY` is required only by server code in `src/lib/supabase/admin.ts` and account/login Server Actions. It must never enter a client component or any `NEXT_PUBLIC_*` variable.

## HR employee directory

`private.employee_directory_details` is a one-to-one extension of the safe organisation person record. It holds the approved employee fields that do not belong in the organisation tree: first and last name, work and personal contact details, team, country, date of birth, scheduled employment-end information and HR-only equipment allocation (laptop supply, laptop/mouse/keyboard IDs and asset tags). A separate narrow controlled response can provide a selected person’s work email to the organisation-tree inspector; it does not make the private table queryable by employees. The canonical start date, title, company and reporting parent remain on the organisation record so the tree and Directory cannot drift.

Only a database-controlled HR, Super Admin, or approved global reviewer account may call the employee-directory list, create and update arbitrary employees or download the CSV. These functions use the signed-in session and controlled role checks; they do not use the Supabase Auth Admin secret. Returned employee-directory data is a deliberately narrow HR DTO, never a direct browser query of the private table. Non-authorised users receive neither the Directory list nor another employee’s private profile.

The CSV route preserves the exact employee headers and order: First Name, Last Name, Work Email, Personal Email, Phone, Job Title, Team, Company, Manager, Country, Date of birth, Start date and Scheduled Employment End Date, then Laptop supplied, Laptop ID, Mouse ID, Keyboard ID and Asset Tags. It protects against spreadsheet formula injection and excludes portal-account data, Auth aliases and passwords. It is generated for the current HR session only; exports are not persisted by the application.

## Self-service profile

The top-right self-profile is intentionally separate from the HR Directory. Employee self-service functions derive the target person from the current active linked Auth account and accept no employee identifier. The only writable fields are the employee’s own phone number, personal email and date of birth. A separate HR-only selected-profile function accepts a selected person ID only after both the Server Action and database function verify the actual HR role; it exposes and updates only those same three contact fields. Work email, work identity, title, reporting relationship, account data and all other employee records remain HR-managed. Updates use the same private employee-detail record and an optimistic detail version, record only changed field labels in the existing audit trail, and never copy private contact values into the public organisation tree.

## Durable leave in production

Migrations `20260817120000_persist_leave_workspace` and `20260818130000_configurable_leave_approval_grants`, with their authenticated Server Actions, are applied to the verified MAM production project and deployed with the application. Leave requests and decisions are stored through narrowly scoped RPCs and refresh in authorised sessions.

The database derives the signed-in employee without accepting an employee or reviewer identifier from the browser. Every submitted request starts **Pending** and has no automatic approval or self-approval. Leave approval is manager-permission based: an active linked profile with the database `manager` role is eligible, and the request walks upward through the organisation tree to the nearest such manager. Ordinary employees in an intermediate reporting position do not intercept approval. HR, Penny and Steven remain global reviewers. At submission, the database snapshots the nearest manager plus any explicit global reviewers onto the request; later hierarchy or role changes do not rewrite decided history, while still-pending work is re-routed when manager permission changes. A global leave-review capability is separate from HR Directory and account administration.

The employee Directory uses an explicit archive state for offboarding. HR, Super Admin, Steven and Penny select an end date and controlled archive reason before a profile leaves the active view. Archived records remain available only to those same authorised accounts; permanent deletion requires an archived, unlinked, history-free profile and is guarded by a database RPC.

The leave calendar is an availability view, not a leave-balance or payroll ledger. An ordinary employee can see company availability but another person's entry is masked as **Away**, with no leave type, reason, employee note, manager note or evidence. Penny must identify the authoritative leave-balance source and calculation before the product exposes any balance information. Supporting attachments use opaque paths in the private `leave-evidence` bucket. The browser receives only authorised metadata and an attachment ID; a server route rechecks the session and request scope before streaming a forced download. Upload intents expire after twenty minutes, private orphan objects become eligible for API deletion after two hours, and the daily `CRON_SECRET`-gated route also prunes 35-day upload-attempt metadata. The release does not claim malware scanning or quarantine.

`public.list_calendar_birthdays()` is a separate security-definer calendar DTO. It requires a current active internal employee (or an HR user who is intentionally outside the roster), reads the private employee-detail table only on the server, and returns active MAM and Equipsy employees' names plus recurring birthday month/day. It does not return a birth year, person ID, company, team, or any contact field. The browser uses safe organisation-row Realtime notifications only as an invalidation signal, then reloads this narrow DTO.

## Durable employee check-ins

- Active employees are enrolled automatically from their canonical start date. Milestone due dates on Saturday or Sunday move forward to the next Monday-to-Friday working day. Reminder lead time is calculated from that scheduled workday, then a resulting weekend advance-notification date moves back to the previous working day.
- Calendar reads a controlled task projection: Todd/HR, Penny and Steven receive all employees; Kieran, Sujant and Serene receive only current organisation-tree descendants. The manager projection omits HR private fields.
- Completion is durable. Reminders due before 1 July 2026 are migration-backfilled complete; no manual enable or catch-up queue is exposed.
- The reminder scheduler claims only due, incomplete work and sends the approved manager message and resource links through the controlled delivery route.
- Production scheduling is owned by the MAM n8n daily 08:00 Australia/Melbourne Schedule Trigger, which calls the server-only `CRON_SECRET`-protected route. The route claims at most two reminders per call and only during 08:00–16:59 Australia/Melbourne; Vercel Cron is intentionally not part of this deployment.
- Before each outbound request, the database re-resolves the current employee and manager and returns a short-lived authorization snapshot. That claimed token is immutable through provider finalisation; later organisation changes apply to later deliveries, while an abandoned claim times out and must pass current-context validation again.

Onboarding and offboarding remain separate review work. No People workflow creates a portal login or provisions or revokes an external system.

This boundary keeps onboarding and offboarding separate until their durable access, retention and audit rules are approved.

## Data model

- `internal_org_people`: authenticated MAM/Equipsy directory nodes and reporting relationships.
- `private.employee_directory_details`: private one-to-one HR employee details linked to a directory person.
- `private.employee_directory_audit_events`: changed-field and actor/time audit metadata for employee-directory mutations, without credential values.
- `profiles`: Auth identity, login name, application role and portal-account lifecycle metadata.
- `private.portal_account_admins`: controlled account-administrator membership.
- `private.portal_account_admin_events`: password-free audit of account administration.
- `teams` and `team_memberships`: controlled team relationships for future live workflows.
- `leave_requests` and `leave_request_events`: RLS-first durable leave model used by the deployed release after migration `20260817120000_persist_leave_workspace` was applied.
- `private.leave_approval_grants`: private, explicit team, global or future-subtree leave-review capability grants; it is not exposed through the browser data API.
- `private.leave_request_reviewer_assignments`: immutable per-request reviewer snapshot created at submission and used for reviewer visibility and decisions.
- `private.employee_check_in_reminders`: durable employee milestone, notification and completion state used by the automatic schedule and Calendar task projection.
- `leave_request_attachments` and `leave-evidence`: durable private attachment metadata and object storage. Request-level database authorisation protects listing/download; a service-only daily retention job removes abandoned objects and expired upload bookkeeping.

The former shared fake-profile/fake-leave tables and their public mutation functions are removed by the account-management migration. The self-profile functions are the only authenticated non-HR access path to private employee-detail data, and each is restricted to the caller’s own record.

## Environments

- Development: local application with a development Supabase project or branch.
- Preview: Vercel branch deployment with isolated, non-production Supabase data.
- Production: MAM-managed accounts, the privately imported roster and approved policies only.

Production secrets are never copied into Development or Preview for convenience.
