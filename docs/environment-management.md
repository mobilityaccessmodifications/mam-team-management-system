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
```

The values change by environment; the names and code do not.

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
- A source workbook is staged and reconciled privately before import. It must not automatically replace identities, deactivate people or relink existing portal accounts.
- A Supabase Management API credential that can apply a migration is an MAM-only operator credential, not an application environment variable. Keep it out of `.env.local`, Vercel, source, logs and screenshots; use it only for a verified, approved operation against the exact MAM project. A project REST key does not authorise arbitrary database DDL.
- GitHub Actions: repository/environment secrets only when CI genuinely requires them.
- Password manager or macOS Keychain: recovery copies and credentials used by approved local tooling.
- Never create `.env.save`; use controlled platform history or the password manager.

## Account secret boundary

The browser uses the publishable key and the signed-in user's cookie-backed session. Account-management operations cross a Server Action that first verifies the session and database-controlled administrator permission. Only then may server code create/read an Auth user, set a password or change the Auth ban state with `SUPABASE_SECRET_KEY`.

The administrator may receive a newly supplied create/reset password once so it can be handed over securely. The secret key cannot reveal an existing password: Supabase Auth stores password hashes and does not provide a password-read API.

Creating an employee record in the HR Directory does not create an Auth user, send an invitation or send an email. HR must create the portal login separately through the authorised Accounts workflow. There is no automated employee-invite route.

## HR employee-data boundary

The organisation tree is deliberately limited to safe structural information: name, position, company and reporting relationship. Private employee details are available only to a database-controlled HR role through authenticated server actions and controlled database functions. The HR CSV is generated on demand for that HR session using the agreed 13-column shape, with Company immediately after Team; it excludes login names, Auth aliases and password data, and the application does not retain the export.

## Deployed durable leave boundary

Migrations `20260817120000_persist_leave_workspace` and `20260818130000_configurable_leave_approval_grants` were applied through approved MAM-only Management API operations to verified project `xtwlrjqbusadghavchqm`, and the matching authenticated application is deployed. Any future application change that calls or changes the leave RPCs must first verify the exact MAM project and applicable migration history.

Leave records and decisions persist only through RLS-protected controlled operations and refresh in authorised sessions. Every submission starts Pending; no automatic or self-approval is permitted. The approved routing policy is held in private database grants: Major Modifications routes to Sujant, Minor Modifications to Serene and Warehouse to Kieran; HR, Penny and Steven are global leave reviewers. Reviewer assignments are snapshotted when the request is submitted, so later organisation-tree or team changes cannot reroute that request. An explicit grant revocation intentionally removes that reviewer’s access and must be followed by an authorised reassignment of affected pending work. A future subtree scope must be granted explicitly and is never inferred from the tree. The calendar is company availability only: ordinary employee peers see **Away**, not another person's leave type, reason, notes or evidence. It is not a leave-balance source; Penny must identify the authoritative leave-balance source before one is displayed. Supporting attachments use private Storage and request-scoped metadata, plus a daily Vercel Cron call to the `CRON_SECRET`-protected cleanup route. The project must retain `CRON_SECRET` and `SUPABASE_SECRET_KEY`; the release has no malware scanner and that limitation must remain visible in the UI and operating notes.

The paired forward migration `20260818140000_shared_calendar_birthdays` must be deployed with its application release. Its separate calendar RPC exposes every active MAM and Equipsy employee's name plus recurring birthday month/day to signed-in internal users, never a birth year or other private data.

## Durable check-in boundary

Active employees receive an automatic check-in schedule from their canonical start date. Weekend milestone due dates move forward to the next Monday-to-Friday working day. Reminder lead time is calculated from that scheduled workday, and any resulting weekend notification moves back to the previous working day. Due tasks appear in Calendar. Todd/HR, Penny and Steven receive the all-staff task projection; Kieran, Sujant and Serene receive only current organisation-tree descendants. Manager responses exclude HR private fields. Reminders due before 1 July 2026 are backfilled complete, and no manual enable or catch-up queue is used.

During the HR test phase, leave submit/approve/decline/cancel events are delivered by the MAM n8n Leave HR Test Email workflow to `hr@mobilityaccess.com.au` only. The application supplies a server-derived request payload and deterministic event key; the receiver rejects browser-supplied recipients and deduplicates retries. No manager, employee, CC or BCC delivery is enabled.

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
# Check-In reminder operations

Production Check-In reminders use the MAM n8n scheduler every 15 minutes to call the People System's `CRON_SECRET`-protected dispatcher. The MAM receiver workflow then sends through the approved MAM Outlook connection. Keep `CRON_SECRET`, `N8N_CHECKIN_REMINDER_WEBHOOK_ORIGIN`, `N8N_CHECKIN_REMINDER_WEBHOOK_URL`, `N8N_CHECKIN_REMINDER_WEBHOOK_SECRET`, `CHECK_IN_MANAGER_GUIDE_URL`, `CHECK_IN_FORM_URL`, and `CHECK_IN_PROBATION_TEMPLATES_URL` in Vercel Production only. This release does not use Vercel Cron.
