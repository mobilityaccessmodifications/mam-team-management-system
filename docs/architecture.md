# Architecture

## System boundary

```text
Browser
  -> Vercel / Next.js
       -> Supabase Auth session (username resolved server-side)
       -> RLS-protected safe organisation and account metadata (publishable key)
       -> HR-authorised employee-directory Server Actions and CSV route
            -> controlled database functions
            -> private employee-detail records
       -> Authorised account-management Server Actions
            -> server-only Supabase secret key
            -> Supabase Auth Admin API
       -> browser-session leave and People workflow state
```

There is no external HR, payroll, AroFlo, calendar, email or provisioning write integration in the current implementation.

## Authenticated directory

- Safer People System covers MAM and Equipsy. Directory rows contain only the name, position, company, reporting parent and ordering metadata required for the live tree.
- The approved roster is imported privately into the verified Supabase project. Real staff rows are not committed in migrations, fixtures, tests or screenshots.
- MAM uses an orange accent and Equipsy uses blue. Company is also rendered in text.
- Next.js verifies the current Auth session and loads its active portal-account link before rendering the application.
- Database membership, controlled administrator records and RLS are the authorisation boundary. User-editable metadata and client state are never accepted as permission claims.
- The organisation tree is a safe structural view only: it exposes name, position, company and reporting relationships, not HR contact or employment details.
- An HR-authorised **Directory** tab is the unified employee editor. It writes the canonical organisation name, title, company, reporting fields and start date together with the person’s private HR detail record. Database functions reject invalid or cyclic reporting relationships, and Realtime distributes committed structural changes to other authorised sessions.
- A supplied HR workbook is staged and reconciled against the live directory before import. Matching is never used to automatically replace identities, deactivate people or relink portal accounts.
- The administrator's **View as** control selects another real directory person's presentation context. It does not replace the Supabase session, authenticate as that person or change the administrator's database permissions.

## Portal accounts

`profiles` is the account registry linked one-to-one to Supabase Auth and to a real directory person. It stores the normalised login name, controlled application role, active/disabled state, password-change metadata, credential validity cutoff and optimistic account version. Private administrator and audit tables control who may manage accounts and record mutations without recording password values.

Normal login is deliberately username-based. The login Server Action resolves the username to an opaque internal Auth address using the server-only client, then asks Supabase Auth to verify the supplied password. The opaque address is not exposed as a staff contact address.

Account-management Server Actions always:

1. verify the caller's Auth session;
2. ask the database whether that caller may manage portal accounts;
3. validate identifiers, login names, passwords and optimistic versions;
4. perform the minimum required Supabase Auth Admin operation; and
5. record the account state through controlled database functions.

The browser receives only safe account fields: directory identity, login name, account status, last sign-in time and account version. Existing passwords can never be returned because Supabase Auth stores non-reversible hashes. Creating an account or resetting a password may return the newly supplied value once to the administrator; it is not persisted in application tables or logs.

`SUPABASE_SECRET_KEY` is required only by server code in `src/lib/supabase/admin.ts` and account/login Server Actions. It must never enter a client component or any `NEXT_PUBLIC_*` variable.

## HR employee directory

`private.employee_directory_details` is a one-to-one extension of the safe organisation person record. It holds the approved employee fields that do not belong in the organisation tree: first and last name, work and personal contact details, team, country, date of birth and scheduled employment-end information. The canonical start date, title, company and reporting parent remain on the organisation record so the tree and Directory cannot drift.

Only a database-controlled HR role may call the employee-directory list, create and update functions or download the CSV. These functions use the signed-in session and controlled role checks; they do not use the Supabase Auth Admin secret. Returned employee-directory data is a deliberately narrow HR DTO, never a direct browser query of the private table.

The CSV route emits the exact employee headers and order: First Name, Last Name, Work Email, Personal Email, Phone, Job Title, Team, Manager, Country, Date of birth, Start date and Scheduled Employment End Date. It protects against spreadsheet formula injection and excludes portal-account data, Auth aliases and passwords. It is generated for the current HR session only; exports are not persisted by the application.

## Browser-session workflows

- The UI contains no seeded fake profiles. Profile and workflow selectors use people loaded from the authenticated live directory.
- Leave requests and decisions created in the current review build live only in React state for the open browser session. They are not written to the retired shared-demo tables or to the live `leave_requests` schema.
- Optional PDF/image evidence is likewise browser-session state and disappears on refresh. The UI exposes it only in the applicable manager/HR review context.
- Onboarding, offboarding and check-in examples start empty. An authorised reviewer may create examples for real directory people; task progress, evidence indicators and reminder state disappear on refresh.
- No browser-session operation creates a portal login, provisions or revokes an external system, schedules a reminder or sends email.

This boundary keeps the real directory and account registry functional while leave and People workflow rules are still being approved. Durable workflow data requires separately designed Server Actions, RLS, retention rules and audit records.

## Data model

- `internal_org_people`: authenticated MAM/Equipsy directory nodes and reporting relationships.
- `private.employee_directory_details`: private one-to-one HR employee details linked to a directory person.
- `private.employee_directory_audit_events`: changed-field and actor/time audit metadata for employee-directory mutations, without credential values.
- `profiles`: Auth identity, login name, application role and portal-account lifecycle metadata.
- `private.portal_account_admins`: controlled account-administrator membership.
- `private.portal_account_admin_events`: password-free audit of account administration.
- `teams` and `team_memberships`: controlled team relationships for future live workflows.
- `leave_requests`, `leave_request_events` and `leave_request_attachments`: RLS-first future live leave model; not used by the current browser-session demonstration.
- `leave-evidence`: non-public Storage boundary prepared for a future approved live attachment flow.

The former shared fake-profile/fake-leave tables and their public mutation functions are removed by the account-management migration.

## Environments

- Development: local application with a development Supabase project or branch.
- Preview: Vercel branch deployment with isolated, non-production Supabase data.
- Production: MAM-managed accounts, the privately imported roster and approved policies only.

Production secrets are never copied into Development or Preview for convenience.
