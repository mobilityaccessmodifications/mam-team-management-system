# Environment and secret management

## The rule

An AI/chat session is not an environment. Use the stable deployment targets below:

| Environment | Purpose | Storage |
|---|---|---|
| Development | Local work | Project `.env.local` with a development Supabase project or branch |
| Preview | Branch/PR verification | Vercel Preview values with isolated, non-production Supabase data |
| Production | Approved staff system | MAM Vercel Production values and MAM production Supabase project |

Do not split credentials by chat session. Do not copy Production secrets into Development or Preview.

## Application variables

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
SUPABASE_SECRET_KEY
NEXT_PUBLIC_APP_URL
SUBSCRIPTION_CREDENTIAL_VAULT_KEY
SUBSCRIPTION_CREDENTIAL_VAULT_KEY_VERSION
SUBSCRIPTION_CREDENTIAL_VAULT_PREVIOUS_KEY
SUBSCRIPTION_CREDENTIAL_VAULT_PREVIOUS_KEY_VERSION
```

The values change by environment; the names and code do not.

## Disposable local E2E guard

`MAM_SANDBOX_E2E=true` is reserved for a disposable local browser-test process.
It requires loopback application and Supabase origins plus local publishable and
server keys. Startup fails closed if any n8n webhook, cron, analytics,
SharePoint resource-link, Supabase Management API or n8n operator credential is
present. While the flag is active, server-side `fetch` accepts loopback URLs
only. This guard supplements a sanitised process environment and browser-level
network interception; it is not a Development, Preview or Production setting.

## Storage rules

- `.env.example`: committed names and safe explanations only.
- `.env.local`: gitignored values for this project's Development environment only.
- Vercel: encrypted values stored separately for Development, Preview and Production.
- Supabase publishable key: browser-safe only when every exposed table/function is protected by RLS and controlled grants.
- `SUPABASE_SECRET_KEY`: server-only Auth Admin credential. It is needed for username resolution and authorised account-management Server Actions. It must never use a `NEXT_PUBLIC_*` name, enter a Client Component, appear in logs/screenshots or be committed.
- Login passwords: held by Supabase Auth, not by environment variables. Never store a staff/admin password in `.env.local`, Vercel, GitHub, source, logs or screenshots.
- Real directory rows: import directly into the verified authenticated Supabase project. Do not place them in environment files, migrations, fixtures, screenshots or client constants.
- Private HR employee details and HR CSV exports follow the same rule: they remain in the verified protected data boundary and must not be placed in environment files, Git, fixtures, screenshots or client constants.
- Durable leave requests and decisions are likewise protected personnel data. Do not export them to environment files, client constants, fixtures, logs or screenshots.
- A payroll source workbook is parsed and reconciled privately before import. Raw CSV/XLSX bytes are not persisted; only bounded validated metadata, a digest, staged rows and audit history remain. It must not automatically replace identities, deactivate people or relink existing portal accounts.
- Subscription-service account email, username, password, MFA details, recovery codes, licence key and notes belong only in the AES-256-GCM vault. The current 32-byte key and version live in the matching Vercel server environment; optional previous-key variables exist only for controlled rotation. Vault keys and plaintext credentials must never enter Git, browser code, exports, logs or screenshots.
- A Supabase Management API credential that can apply a migration is an MAM-only operator credential, not an application environment variable. Keep it out of `.env.local`, Vercel, source, logs and screenshots; use it only for a verified, approved operation against the exact MAM project. A project REST key does not authorise arbitrary database DDL.
- GitHub Actions: repository/environment secrets only when CI genuinely requires them.
- Password manager or macOS Keychain: recovery copies and credentials used by approved local tooling.
- Never create `.env.save`; use controlled platform history or the password manager.

## Account secret boundary

The browser uses the publishable key and the signed-in user's cookie-backed session. Account-management operations cross a Server Action that first verifies the session and database-controlled administrator permission. Only then may server code create/read an Auth user, set a password or change the Auth ban state with `SUPABASE_SECRET_KEY`.

The administrator may receive a newly supplied create/reset password once so it can be handed over securely. The secret key cannot reveal an existing password: Supabase Auth stores password hashes and does not provide a password-read API.

Creating an employee record in the HR Directory does not create an Auth user, send an invitation or send an email. HR must create the portal login separately through the authorised Accounts workflow. There is no automated employee-invite route.

## HR employee-data boundary

The organisation tree is deliberately limited to safe structural information: name, position, company and reporting relationship. Private employee details are available only to an active database-controlled System Admin through authenticated server actions and controlled database functions. The employee CSV is generated on demand for that authorised session using the agreed 13-column shape, with Company immediately after Team; it excludes login names, Auth aliases and password data, and the application does not retain the export.

## Deployed durable leave boundary

Migrations `20260817120000_persist_leave_workspace` and `20260818130000_configurable_leave_approval_grants` were applied through approved MAM-only Management API operations to verified project `xtwlrjqbusadghavchqm`, and the matching authenticated application is deployed. Any future application change that calls or changes the leave RPCs must first verify the exact MAM project and applicable migration history.

Leave records and decisions persist only through RLS-protected controlled operations and refresh in authorised sessions. Every submission starts Pending; no automatic or self-approval is permitted. The approved routing policy is held in private database grants: Major Modifications routes to Sujant, Minor Modifications to Serene and Warehouse to Kieran; HR, Penny and Steven are global leave reviewers. Reviewer assignments are snapshotted when the request is submitted, so later organisation-tree or team changes cannot reroute that request. An explicit grant revocation intentionally removes that reviewer’s access and must be followed by an authorised reassignment of affected pending work. A future subtree scope must be granted explicitly and is never inferred from the tree. Calendar is available to every active employee, but ordinary employee projections contain only that employee's own Pending/Approved leave, Check-in dates and birthday; Managers additionally receive active birthdays from their reporting subtree, while peers' leave remains omitted. Gerard (Accounts) and Jackie (Bookkeeper) receive separately configured view-only access to current and archived employees' named Approved leave, including the exact schedule and duration needed for payroll processing, with the category reduced to **Approved leave** and archived names suffixed `(archived)`. Reasons, notes, evidence, balances and approval authority remain excluded, and Calendar is not a leave-balance source. Supporting attachments use private Storage and request-scoped metadata, plus a daily Vercel Cron call to the `CRON_SECRET`-protected cleanup route. The project must retain `CRON_SECRET` and `SUPABASE_SECRET_KEY`; the release has no malware scanner and that limitation must remain visible in the UI and operating notes.

Migration `20260916140000_private_team_calendar_birthdays` replaces the original broad birthday RPC with employee-self, Manager-self-plus-subtree and System-Admin scopes while preserving the name plus recurring month/day-only return contract. Its paired n8n validator removes birthday CC recipients; the database scheduler resolves the nearest active Manager and, after `20260917110640_victorian_public_holiday_workdays`, sends on the preceding published Victorian business day. Migration `20260916130000_personal_calendar_scope` and its target-checked deployment helper configure the newer personal leave/Check-in scope, Gerard's importer preview and Gerard/Jackie's approved-leave Calendar access without embedding staff identities in schema SQL. Configuration accepts only owner-confirmed SHA-256 identity fingerprints binding the canonical person/Auth links, company and current HR identity fields; display-name or first-name matching is not an authorisation mechanism.

This paired release requires payroll migration `20260915120000_payroll_balance_self_service_import` before the application starts calling its importer/reminder RPCs, followed by subscription migration `20260915130000_subscription_billing_details` before the application starts calling the V2 subscription RPCs. Apply both only to verified MAM project `xtwlrjqbusadghavchqm`, then grant the approved active payroll delegate through the audited application function. The follow-up email release adds migration `20260915140000_payroll_balance_email_reminder`; configure its named recipient as deployment data through the target-checked helper rather than encoding a staff identity or address in the migration. Production verification must cover staged preview, held-row non-application, current-month MAM/Equipsy reminder state, subscription billing-date calculation, last-review audit derivation, vault reveal/expiry boundaries and address-free reminder outbox state without printing real employee or credential values.

## Durable check-in boundary

Active employees receive an automatic check-in schedule from their canonical start date. Weekend and published Victorian public-holiday milestone due dates move forward to the next Victorian business day. Reminder lead time is calculated from that scheduled workday, and any resulting weekend or public-holiday notification moves back to the previous Victorian business day. Due tasks appear in Calendar. An active System Admin receives the all-staff task projection; an active manager receives only current organisation-tree descendants. Manager responses exclude HR private fields. Reminders due before 1 July 2026 are backfilled complete, and no manual enable or catch-up queue is used.

Leave submission and cancellation are delivered by the MAM n8n Leave Email Delivery workflow to the request's server-resolved nearest active manager/admin. Approval and decline are delivered to every HR-recorded employee address (Work and Personal, when present), with duplicate addresses removed. Every leave notification CCs `hr@mobilityaccess.com.au`; approved and cancelled leave notifications additionally CC `accounts@mobilityaccess.com.au`. The application supplies a server-derived recipient and CC payload plus deterministic event key; the receiver rejects browser-supplied recipients and deduplicates retries.

The same authenticated n8n receiver accepts a separate strict `payroll-balance-reminder` event. Its recipient is resolved from the configured person's current HR work email by a service-only database preparation step, never from the request or browser. The workday-level outbox permits one claim on each published Victorian business day from 08:00 through 16:59 while either current-month company snapshot remains missing. Same-day retries reuse the same event key, weekends and public holidays create no row, and completion stops later reminders. It sends no CC and omits delivery when both MAM and Equipsy snapshots are already current. Publish only through the verified MAM n8n REST API and never execute the workflow as a test.

## Environment verification

Before any production migration, Auth change, secret update or deployment:

1. Verify GitHub login `mobilityaccessmodifications` and repository `mobilityaccessmodifications/mam-team-management-system`.
2. Verify Supabase organisation `fwlmbmospuwoaosffvmw` and project `xtwlrjqbusadghavchqm` with approved MAM-only Supabase Project/Management API access. For a migration, verify the Management API operation targets that exact project; do not rely on an unrelated account session or a project REST key.
3. Verify Vercel target `ai-7033s-projects/mam-team-management-system` using `/Users/nixon/.vercel-profiles/mam`.
4. Confirm the operation's exact environment scope.
5. Avoid printing secret values or private roster rows.
6. For a future change to durable leave or check-ins, confirm the applicable migration history before deployment, then test persistence, authorised scope, Calendar projection and privacy boundaries.

## Session workflow

Every AI session should:

1. Open the canonical project directory.
2. Read `AGENTS.md` and `README.md`.
3. Load `.env.local` only through the application or a locked helper.
4. Verify the expected account/project before external reads or writes.
5. Never copy credentials into chat, Memory, shell profiles or another project.
# Reminder operations

Production Check-In reminders use the MAM n8n scheduler daily at 08:00 Australia/Melbourne to call the People System's `CRON_SECRET`-protected dispatcher. The dispatcher claims up to ten reminders, sends the bounded batch concurrently, and returns `backlogLikely: true` when another in-window retry may be needed. The MAM receiver workflow sends through the approved MAM Outlook connection to the server-resolved manager/admin and CCs `hr@mobilityaccess.com.au`. The existing leave/birthday scheduler also calls the consolidated priority endpoint; on each published Victorian business-day run its service-only payroll outbox may send one named-recipient balance reminder through that same Outlook connection with no CC, continuing until both current-month snapshots are complete. Keep `CRON_SECRET`, `N8N_CHECKIN_REMINDER_WEBHOOK_ORIGIN`, `N8N_CHECKIN_REMINDER_WEBHOOK_URL`, `N8N_CHECKIN_REMINDER_WEBHOOK_SECRET`, `CHECK_IN_RESOURCE_ORIGIN`, `CHECK_IN_MANAGER_GUIDE_URL`, `CHECK_IN_FORM_URL`, `CHECK_IN_PROBATION_TEMPLATES_URL`, `CHECK_IN_LEGACY_FORMS_FOLDER_URL`, `MAM_N8N_LEAVE_WEBHOOK_ORIGIN`, `MAM_N8N_LEAVE_WEBHOOK_URL`, and `MAM_N8N_LEAVE_WEBHOOK_SECRET` in Vercel Production only. Email reminder dispatch does not use Vercel Cron.
