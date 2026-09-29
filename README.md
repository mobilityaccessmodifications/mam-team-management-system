# Safer People System

Safer People System is the private people portal for Mobility Access Modifications (MAM) and Equipsy. It combines the live organisation directory, account administration, leave visibility and essential people workflows in one minimal workspace. Recruitment is excluded.

## Current status

- Frontend: Next.js 16 App Router, React 19 and TypeScript
- Hosting: the MAM-owned Vercel project at `https://mam-team-management-system-ten.vercel.app`
- Source: `mobilityaccessmodifications/mam-team-management-system`
- Data and authentication: MAM Supabase project `xtwlrjqbusadghavchqm`
- Directory: the live MAM and Equipsy roster, with a private one-to-one HR employee-detail store; there are no demo roles, every active linked employee has a limited top-right self-service profile, and an authorised HR administrator may select a real employee view from the sidebar
- Accounts: employee email/password login backed by Supabase Auth and a database-controlled account registry. Company email takes priority over personal email; standalone administrator usernames remain unchanged.
- Leave rollout: durable leave migration `20260817120000_persist_leave_workspace` is applied to the verified MAM production project and the matching application is deployed at the fixed production URL. Leave requests and decisions now persist through controlled, RLS-protected operations.
- Check-ins: active employees receive an automatic, durable milestone schedule; onboarding and offboarding remain separate review work
- Payroll self-service and subscriptions: authorised payroll delegates and System Admin can stage CSV/XLSX leave-balance exports, review exact same-company matches and apply only safe rows; paid subscriptions also include seats, generic credit-card use and cardholder name, billing date, next billing and last reviewed fields.

MAM people use the orange accent and Equipsy people use blue. Company is also stated in text, so colour is never the only company indicator.

The chart opens in **Default** layout: Equipsy reports stack vertically, and Minor Mods shows Scheduler, Installer, Estimator and Administrator columns beneath its team leader. The full Minor Mods subtree is grouped by role for this display, including people nested below other employees; reporting records stay intact. Fullscreen preserves the selected layout and does not enable Arrange automatically. Users can choose Horizontal, Vertical or By role, adjust individual branches, or choose Default again to restore the preset. These visual choices are local to the open chart. Search and relationship editing retain the structural team nodes; small screens retain the readable stacked tree.

The current live reporting baseline places all active Team Leaders under the MAM Director. Minor Mods is grouped beneath its Team Leader into Scheduling team, Estimating team, Trades team, Admin team and an intentionally empty CSO team; these are safe structural organisation nodes, not private employee records.

## What works now

After login, the server verifies that the Supabase Auth user is linked to an active directory person. Managers, HR and System Admin can use the complete live organisation tree, search it, and open a selected person’s work email. Ordinary employees cannot open the organisation chart. The tree does not expose a private employee list or private profile fields.

Every active linked employee also has a top-right **My profile** control. It shows that person’s own safe work identity, team and manager context, their HR-managed work email, and their own private contact details. They may update only their phone number, personal email and date of birth. Work email is intentionally read-only and must be changed by HR. The controlled System Admin may use **Change profile** to exercise a selected real employee workflow for testing. The signed-in Auth identity and audit actor always remain the real System Admin, whose existing server-side permissions are retained; the selected employee never receives or inherits those permissions.

Only a database-authorised HR user receives the master view. HR can:

- create a login for an unlinked directory person;
- view login names, account status and last sign-in time;
- change a login name;
- set a new password; and
- disable or re-enable an account; and
- open the private employee Directory, add or edit a person, and export the approved employee CSV.

The **Directory** is HR-only and is the single all-staff employee editor. It contains the complete employee list and the private contact, employment and equipment-allocation fields needed by HR, such as work and personal contact details, phone number, date of birth, laptop allocation and asset IDs. An employee’s My profile updates only their permitted fields in that same private record; it is not an alternative all-staff Directory. Employees never receive the roster, another person’s private details, the CSV export, equipment allocation or the Accounts view. The employee CSV is separate from portal accounts: it never includes login names, Auth addresses or passwords. Creating a directory record does not create a portal login, invitation or email: HR creates a login separately in **Accounts** and hands it over through the approved process.

Supabase Auth stores passwords as non-reversible hashes. HR can set a replacement password and see that newly generated value once, but neither the application nor HR can retrieve an existing password.

Email login uses the existing account registry and unique, case-normalised login index. It does not replace the internal Auth address, change passwords or alter account permissions. Deploy the email-capable application through GitHub, then apply `20260918110000_employee_email_login` through `scripts/deploy-employee-email-login.py` using the MAM credential wrapper. Existing usernames remain valid throughout both steps. Only after both releases are verified, perform the separately authorised employee renames. An employee awaiting an email retains their existing login until their address is supplied. Disabled and archived accounts remain disabled.

The deployed Leave workspace supports full-day and timed leave across one or more dates, sick leave, manager decisions and a privacy-preserving team calendar. Times are limited to 6:00 am–6:00 pm in 15-minute intervals. Authenticated requests and decisions are stored through the controlled leave operations and refresh across authorised accounts.

Migrations `20260817120000_persist_leave_workspace`, `20260818130000_configurable_leave_approval_grants` and `20260824170000_manager_based_leave_approval` are applied to the verified MAM production project before the matching application release. Every submitted request starts **Pending**: there is no automatic approval or self-approval. The database uses the active `manager` role and reporting tree to route each request to the nearest manager with approval permission; non-manager employees in between do not intercept it. HR, Penny and Steven remain global reviewers. The database snapshots the authorised reviewers when a request is submitted and re-routes still-pending work when manager permission changes. A global leave-review capability does not grant HR Directory or account access. Calendar is not a leave-balance ledger: ordinary employees receive their own leave plus only approved, category-minimised availability for active same-company peers under the same nearest active Manager or System Admin; managers additionally receive approved leave across their company and submitted/approved leave for their company-matched reporting descendants, as well as active birthdays from their reporting subtree. Separately granted Accounts/Bookkeeping Approved-leave viewers receive names, dates, exact schedule and duration needed for payroll processing with another employee's category minimised. Reasons, notes, evidence, balances and decision authority remain excluded. The pending or approved request owner can add up to ten private supporting PDF/image files. Metadata is scoped through controlled database functions, downloads are re-authorised server-side and forced as attachments, and only the original uploader can confirm deletion. A bounded daily job removes abandoned or deletion-orphaned uploads. Files are not malware-scanned, so the documented HR handling policy remains part of the release boundary.

Migration `20260916140000_private_team_calendar_birthdays` replaces the original broad birthday projection. An employee sees only their own birthday, a Manager sees their own plus active people in their reporting subtree, and System Admin retains the operational all-active view. Every response remains limited to a name and recurring day/month—never a birth year, identifier, company, team or contact data. The matching n8n validator sends the preceding-working-day reminder only to the server-resolved Manager, without HR or Accounts CC.

Check-in schedules are generated automatically from each active employee's start date. Milestone due dates that fall on a weekend or a published Victorian public holiday move forward to the next Victorian business day. The agreed reminder lead time is then measured from that scheduled workday; any resulting weekend or public-holiday notification moves back to the previous Victorian business day. Due tasks appear in the authorised reviewer's Calendar. There is no manual enable or queue step. Todd/HR, Penny and Steven can review all employees; Kieran, Sujant and Serene can review only current descendants in the organisation tree. Manager views exclude HR-private contact and profile fields. Migration history before 1 July 2026 is marked complete rather than queued for catch-up.

The payroll self-service release adds a first-Victorian-business-day Calendar reminder and a restricted **Balance** tab beside Leave approvals. The tab is visible only to System Admin and active linked payroll delegates; manual balance editing remains System Admin-only. System Admin can grant the importer capability without granting the broader employee Directory or subscription register. CSV and `.xlsx` files are archived server-side in private Storage before parsing, retained for at least 30 days even when parsing fails, staged into a private preview and matched only to one active person in the same company after punctuation/spacing normalisation. The raw archive and its path are never exposed in the browser; the existing daily private-file maintenance job removes eligible files only after their retention date. Inactive, unmatched, cross-company and ambiguous rows are retained for review and never update a balance. At the 08:00 n8n run on each published Victorian business day, the explicitly configured payroll recipient receives one Outlook email naming only the current-month company snapshots still required. The reminder repeats on each later business day until both snapshots are complete; weekends and public holidays are skipped and no email is sent once both snapshots are current.

Paid subscription records in the same release record seats/licences, whether a credit card is used, a free-text cardholder or company-card name, the billing anchor date and a server-calculated next billing date. The label is company-neutral so MAM and Equipsy cards can both be recorded. Never enter a card number, expiry date or security code. Last Reviewed Date is derived from the audited review event. Service account email, username, password, MFA details, recovery codes, licence key and notes belong only in the separate encrypted credential vault, never in the subscription register or an export.

## Data boundaries

- Real names, positions, companies and reporting relationships live only in the authenticated, RLS-protected Supabase directory. The complete organisation chart is limited to active Managers, HR and System Admin. Ordinary employees receive only their safe team-Directory branch and no Organisation tab; the projection exposes name, position, company and reporting relationship and, only when a person is selected, that person’s work email.
- HR employee details live in a private one-to-one record linked to the organisation person. Only HR-authorised database functions may return the complete employee list or an arbitrary selected private profile. A separate controlled self-profile response may return an active linked employee’s own phone number, personal email, date of birth and read-only work email; it never accepts a browser-supplied person identifier. The private roster is never committed to Git or copied into fixtures.
- The HR CSV export preserves its 13 agreed employee columns—First Name, Last Name, Work Email, Personal Email, Phone, Job Title, Team, Company, Manager, Country, Date of birth, Start date and Scheduled Employment End Date—then appends the HR-only hardware audit columns: Laptop supplied, Laptop ID, Mouse ID, Keyboard ID and Asset Tags. It contains no portal-account or credential data, is generated only for an authorised HR session and is not stored in Git.
- The HR employee editor writes the canonical organisation fields and broadcasts committed changes through Realtime, so the safe organisation tree updates in other authorised sessions. Self-service contact changes are saved to the same private employee-detail record but do not change the public organisation fields.
- A supplied HR workbook is staged and reconciled before import. It is never an instruction to automatically replace identities, deactivate people or relink existing accounts.
- Account links, normalised login names, status and audit metadata live in Supabase. The Accounts view and account-management actions are HR-only. Supabase Auth remains the only password store.
- Subscription-service login details are separate from portal accounts. The encrypted credential vault stores account email, username, password, MFA details, recovery codes, licence key and notes only as AES-256-GCM ciphertext plus key metadata; plaintext is never returned in a list, export or initial page response. A current System Admin has access by role, while any additional credential delegates are selected by the System Admin and receive only the credential catalogue, not subscription costs, ownership or member data.
- The credential-free company subscription register is read-only for active Managers and HR and manageable only by System Admin. Penny and Steven receive it through their controlled System Admin roles. Ordinary employees do not receive the register tab and keep only their self-scoped assigned-subscription cards.
- Durable leave and check-in data persist only through controlled, RLS-protected operations. Onboarding and offboarding review work remains separate from the automatic check-in register.
- Leave approval is an independent private capability. Active linked employees submit their own requests; the nearest active linked `manager` profile in the reporting tree is selected first, with explicit global reviewers retained for all-company oversight. A non-manager employee cannot intercept requests from people below them. Still-pending requests are re-routed when manager permission changes, and no reviewer, including an HR or global reviewer, may decide their own request.
- Ordinary employees see their own leave and approved, category-minimised availability for active same-company peers with the same nearest person manager. Explicit Accounts/Bookkeeping Approved-leave viewers receive current and archived employees' names, dates, exact schedule and duration needed for payroll processing plus the category-minimised label **Approved leave**; archived names carry an `(archived)` suffix, while reasons, notes, evidence, balances and decision authority remain absent.
- Calendar birthdays are a deliberately narrow exception to the private date-of-birth boundary. An employee receives only their own recurring birthday, a Manager receives their own plus active reporting descendants, and System Admin receives the all-active operational view. The projection returns only name and recurring month/day; no birth year, identifier, company, team or contact field is returned.
- Leave entries remain an availability view rather than a balance ledger. A shared read-only Calendar layer shows every user the officially published 2025–2028 Victorian public holidays; unconfirmed AFL Grand Final dates are not guessed. Migration `20260917110640_victorian_public_holiday_workdays` mirrors those source-backed dates into a private scheduling table so Check-ins, paid-subscription reviews, payroll-balance work and work-email reminders move off a public holiday. Employee leave and birthday events keep their actual dates, and the change does not alter leave-duration or accrual calculations. Payroll balances remain separate dated snapshots imported from authorised payroll exports. The recurring email recipient is a stable configured person ID whose current active portal link, import grant and HR work email are revalidated immediately before delivery; the browser never supplies the address.
- Check-in reminder email delivery is limited to the automatically calculated manager schedule and approved resource links.
- Leave submission and cancellation notifications are routed to the request's server-resolved nearest active manager/admin; approval and decline notifications are routed to every HR-recorded employee address (Work and Personal, when present), with duplicate addresses removed. Every leave notification CCs `hr@mobilityaccess.com.au`; approved and cancelled leave notifications additionally CC `accounts@mobilityaccess.com.au`. The browser cannot choose a recipient; the receiver validates the signed payload and deduplicates repeated event deliveries.
- Production reminder dispatch runs through MAM n8n, which calls `CRON_SECRET`-protected People System endpoints. The consolidated leave/birthday/payroll route accepts claims only on published Victorian business days during the applicable 07:00–16:59 or 08:00–16:59 window. Birthday mail is generated at 07:00 on the preceding Victorian business day and goes only to the birthday employee's server-resolved Manager, with no CC. One payroll row and delivery key are created per eligible business day while either company snapshot remains missing; same-day retries reuse that key, weekends and public holidays create no row, and completion stops the series. Payroll mail goes only to the server-resolved named recipient with no CC. Check-in reminders are sent to the server-resolved manager/admin and CC `hr@mobilityaccess.com.au`. Vercel Cron is not used for email reminder dispatch; it runs only the bounded daily private-file cleanup for leave attachment orphans and expired payroll source archives declared in `vercel.json`.

## Local development

Use a development Supabase project or branch. Do not copy production secrets into local development.

```bash
npm ci
cp .env.example .env.local
npm run dev -- -p 3001
```

Open `http://localhost:3001`.

The authenticated portal requires all three Supabase variables shown below. A disconnected local shell is not a substitute for the real directory and account boundary.

For disposable browser E2E testing, set `MAM_SANDBOX_E2E=true` and supply only
loopback `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_APP_URL` values plus local
Supabase keys. Next.js then refuses to start when outbound webhook, cron,
analytics, resource-link or operator credentials are present, and server-side
`fetch` is restricted to loopback destinations. Keep the flag disabled in
ordinary Development, Preview and Production; it is an explicit test-process
guard.

## Verification

```bash
npm run check
```

This runs lint, type-checking, unit tests and the production build. Run the
separate SQL, browser and bundle gates described in [local verification](docs/local-verification.md)
before releasing changes to those boundaries.

## Environment variables

| Variable | Exposure | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Browser-safe | Supabase API URL for the selected environment |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Browser-safe | Publishable key constrained by RLS |
| `SUPABASE_SECRET_KEY` | Server-only | Supabase Auth Admin access used by authorised account-management Server Actions |
| `MAM_ANALYTICS_API_KEY` | Server-only | Dedicated bearer key for the read-only server-to-server dashboard API |
| `NEXT_PUBLIC_APP_URL` | Browser-safe | Exact application origin used for in-app links |
| `MAM_SANDBOX_E2E` | Server-only | Explicit local E2E startup and outbound-network kill switch |
| `SUBSCRIPTION_CREDENTIAL_VAULT_KEY` | Server-only | Current 32-byte base64 AES-GCM key for subscription-service credentials |
| `SUBSCRIPTION_CREDENTIAL_VAULT_KEY_VERSION` | Server-only | Positive version associated with the current vault key |
| `SUBSCRIPTION_CREDENTIAL_VAULT_PREVIOUS_KEY` | Server-only | Optional previous key retained only while rotating existing records |
| `SUBSCRIPTION_CREDENTIAL_VAULT_PREVIOUS_KEY_VERSION` | Server-only | Version associated with the optional previous key |

`SUPABASE_SECRET_KEY` must never use a `NEXT_PUBLIC_*` name, enter client code, appear in logs or be committed. Production keeps it only in the MAM Vercel project's encrypted Production environment. Login passwords are not application environment variables.

The dashboard API is a separate server-to-server boundary. It exposes approved
operational history through `/api/analytics/v1` only after a dedicated
`MAM_ANALYTICS_API_KEY` has been configured; it never gives an analyst direct
Supabase access or a service-role key. See `docs/analytics-api.md`.

See `docs/environment-management.md` for the complete environment model.

## Project documentation

- `AGENTS.md` — project operating and safety rules
- `docs/project-brief.md` — current scope and delivery definition
- `docs/business-rules.md` — confirmed rules and decisions required before live workflow use
- `docs/architecture.md` — application, authentication and data boundaries
- `docs/environment-management.md` — secrets and environment strategy
- `docs/decisions/0001-platform.md` — platform decision

## Deployment order

1. Verify GitHub owner `mobilityaccessmodifications` and repository `mam-team-management-system`.
2. Verify Supabase organisation `fwlmbmospuwoaosffvmw` and project `xtwlrjqbusadghavchqm` before any read, migration or Auth change.
3. Review and apply versioned migrations, then run Supabase security and performance advisors.
4. Verify the Vercel target is `ai-7033s-projects/mam-team-management-system` and remains linked to the company repository.
5. Store the publishable values and server-only secret separately for Development, Preview and Production.
6. For any future production change, verify the applicable migration history in the exact MAM project. Test leave persistence and privacy, plus automatic check-in scheduling, weekend due-date forward adjustment, weekend advance-notification backward adjustment, Calendar visibility, role scope, manager-view data minimisation and the pre-1-July-2026 completed backfill.
7. Deploy without changing the established production URL.

### Analytics API employee names

The `employees` dataset includes `first_name` and `last_name`, sourced only
from the private employee-detail record. It does not expose HR contacts or
grant access to the HR directory RPC. Before releasing this change, run
`scripts/deploy-analytics-employee-names.py inspect` and then
`apply <reviewed-sha256>` through the MAM Supabase credential wrapper. This
hash-pinned helper verifies the exact project, predecessor migration, private
name columns, RPC security attributes and grants; it applies only this
transactional migration through the Management API and records the migration
with its exact source. Do not use `supabase db push` for this release because
the production ledger contains unrelated version drift. After the helper
verifies the schema, merge the reviewed PR into `main` and verify the MAM
Vercel production deployment. Ask the Maton/Power BI owner to refresh the
existing connection and confirm the two fields appear; do not rotate its key.

### Leave request email privacy

Leave request emails include dates, business days, requested hours and status,
but no annual, sick/personal, Xero or projected balance amounts. Conditional
approval emails explicitly say “approved, subject to sufficient leave balance”
in the subject, message and status; this wording also applies to their reminders. The dispatcher strips
legacy balance fields before the n8n webhook. Full-time full-day requests use
7.6 hours per business day; explicit hourly requests keep their recorded hours.

Release order: apply the reviewed Supabase migration to the verified MAM
project, merge the reviewed app into `main`, and verify Vercel production.
Publish `workflows/leave-notification-validator.n8n.txt` through the existing
target-checked n8n release path. The migration never replays historical emails
or changes payroll balances; the application also strips any legacy queued
balance snapshot before dispatch.

### Workday payroll balance email

Migration `20260915140000_payroll_balance_email_reminder` adds a private
recipient configuration and append-only delivery audit. Forward migration
`20260915150000_weekday_recurring_payroll_balance_email_reminder` changes the
outbox from one row per month to one row per workday. Forward migration
`20260917110640_victorian_public_holiday_workdays` excludes published Victorian
public holidays and moves the in-app monthly due marker to the first Victorian
business day. The existing
MAM n8n scheduler and Outlook receiver are reused; the receiver accepts the
strict `payroll-balance-reminder` event and sends no HR or Accounts copy.
Delivery is skipped when both MAM and Equipsy already have a current-month
linked snapshot, and otherwise the message names only the missing company or
companies and links to the Leave upload panel. Same-day retries are deduplicated;
the following workday gets a new durable row only while data remains missing.

Release the backward-compatible n8n validator with
`scripts/deploy-priority-n8n.py ... receiver`, apply the reviewed migration with
`scripts/deploy-payroll-balance-email-reminder.py apply <reviewed-sha256>`, then
configure the authorised named recipient with its `configure-recipient` mode
through the MAM Supabase credential helper. Merge the application through
GitHub to trigger Vercel production. Verify both helpers through read-only API
inspection; do not execute the mail workflow or send a test email.
For the recurring-workday follow-up, apply the hash-pinned forward migration
with `scripts/deploy-payroll-balance-weekday-reminder.py apply <reviewed-sha256>`.
Apply the later source-backed holiday exclusion only after review with
`scripts/deploy-victorian-public-holiday-workdays.py apply <reviewed-sha256>`;
its inspection output contains schema booleans and aggregate schedule counts,
never employee or leave records.

### Payroll source-file retention

Migration `20260918100000_payroll_balance_source_file_retention` adds the
private raw-file archive and service-only retention functions used by the
payroll importer. Apply it before merging the matching application with
`scripts/deploy-payroll-balance-source-retention.py apply <reviewed-sha256>`
through the MAM Supabase credential helper. The helper verifies the exact MAM
organisation/project, reviewed migration hash, private bucket, 30-day database
constraint and browser-denied privileges without printing file or employee
data. The application release can then use the existing daily private-file
cleanup route to delete only archives whose retention date has passed.

### Personal Calendar scope

Migration `20260916130000_personal_calendar_scope` makes Calendar available to
every active employee while limiting ordinary employees to their own
Pending/Approved leave and Check-in dates. Migration
`20260916140000_private_team_calendar_birthdays` also limits birthdays to self
for employees and self plus active reporting descendants for Managers. A
separate Accounts/Bookkeeping view-only grant exposes current and archived employees' named Approved leave,
exact schedule and duration needed for payroll processing, with the category
reduced to `Approved leave`; it does not grant approval, reasons, notes,
attachments or balance access, and archived employee names carry an `(archived)` suffix.
Apply the reviewed migration with
`scripts/deploy-personal-calendar-scope.py apply <reviewed-sha256>`, then run
its `configure` mode to retain Gerard's payroll upload access and add the
approved Calendar grants for Gerard and Jackie. The reviewed, owner-confirmed
opaque deployment fingerprints bind canonical person/Auth IDs, company and
current HR identity fields without committing or printing those fields. Any
identity drift fails closed. Both operations verify the exact MAM target.

For the birthday privacy release, first apply the reviewed migration with
`scripts/deploy-private-team-birthdays.py apply <reviewed-sha256>`, then publish
the reviewed receiver validator through `scripts/deploy-priority-n8n.py` so
birthday reminders have no CC. Merge the application through GitHub only after
both server-side boundaries are verified; the app's Change Profile path calls
the new selected-scope RPC.

Managers’ Calendar includes their active reporting subtree’s pending and approved
leave, including indirect reports through org units. Shared entries expose only
name, dates, duration and status; ordinary employees remain self-only.
Deploy the reviewed `20260921160000_manager_team_leave_calendar.sql` with
`scripts/deploy-manager-team-calendar.py apply <reviewed-sha256>` through the
MAM Supabase credential wrapper; `inspect` verifies the deployed scope.

Self-service Annual/Unpaid leave for non-ABN staff requires 14 calendar days’
notice in Melbourne. Managers may still log leave on behalf of employees.
Apply the reviewed insert-time policy with `scripts/deploy-leave-notice.py apply
<reviewed-sha256>` through the MAM credential wrapper before merging its UI.

### Calendar team filters (21 September 2026)

Managers retain reporting-team Pending/Approved visibility and may also view other active teams’ Approved leave across both companies. Other employees retain existing scope; payroll grants retain archived approved history. New `list_leave_calendar_entries_with_teams` RPCs add only the HR team label to the existing authorised projections. Calendar filters use these labels and the permitted event layers, including search, without changing the selected view/date.

Deploy `20260921180000_calendar_team_filters.sql` through `scripts/deploy-calendar-team-filters.py inspect` then `apply <reviewed-sha256>` using the MAM credential helper before merging the UI release. The script verifies the exact organisation/project, predecessor migration, source hash and deployed function grants.

### Comparison-only payroll uploads

Gerard’s importer identity is configured in the private comparison-only importer
allowlist. His parsed uploads save an immutable comparison against current
available annual/sick hours (stored payroll hours minus approved People Hub leave),
rounded to two decimal places for comparison. Missing balances and unmatched rows
are flagged; no leave balance is overwritten, including through the old commit RPC.
Snapshot dates are retained so reviewers can distinguish different reporting periods.
A durable, leased alert queue sends a count-only warning to
marketing@mobilityaccess.com.au through the existing authenticated n8n receiver.
The leave-notification cron and independent recovery scheduler retry delivery.
Repeated staging of the same open batch does not create another alert.
Source files retain the existing minimum 30-day archive. Recent imports can reopen
the saved comparison for the uploader or Super Admin. Comparison uploads satisfy
monthly file-upload reminders; resolving differences remains a separate review.
Deploy `20260922150000_payroll_comparison_alerts.sql` with the target-checked
`scripts/deploy-payroll-comparison.py`, configure the verified Gerard grant, and
publish the reviewed n8n receiver before releasing the application.

### Leave email routing verification

Submission/cancellation email routing must use current authorised reviewers,
not the first person in the organisation tree. Manager-owned requests retain
the configured global reviewer group. To check for production function drift,
run `scripts/deploy-leave-email-route.py inspect` through the MAM Supabase
credential helper. Release `20260922170000` with `apply <reviewed-sha256>`;
it reasserts the resolver, verifies its exact body and service-only access,
and does not resend mail or alter approved requests or immutable retry payloads.

### Automatic conditional-approval hours

Migration `20260922180000` fills missing conditional-approval hours from the
request (explicit hours first; otherwise 7.6 per full-time day or 7.5 per other
day). New approvals save those hours atomically, including inserts from an
older page during rollout. The approval page no longer asks reviewers to
re-enter them. Balance-ready reminders reserve other approved leave before
checking the threshold and still require a final reviewer decision.

Run `scripts/deploy-automatic-leave-required-hours.py inspect`, then
`apply <reviewed-sha256>` through the MAM Supabase credential helper before
merging the UI. The script checks the target, predecessor, function bodies,
private insert guard and backfill. It neither approves requests nor replays mail.

### Device QR labels and register bulk editing

Asset labels now encode the fixed production `/assets/MAM-IT-…` URL as a QR
code, with the readable asset number retained in downloads and printed labels.
The Assets toolbar and signed-in phone header open a camera scanner with manual
asset-number fallback. Camera images stay in the browser; leaving the scanner
stops the camera. Device links require an active account: System Admin receives
the existing inventory view, employees receive only their own assigned-device
projection. A scanned code never grants access or opens a third-party URL.

Assets, Subscriptions and Accounts have leading selection controls. Assets
reuse audited ownership/return operations; Accounts reuse the existing
enable/disable workflow and keep login/password editing individual. Subscription
bulk editing changes only chosen company, status and responsible-person fields;
it preserves all other billing, membership and credential data. Each save
checks the record version, and unconfirmed rows remain selected after a batch.

Before merging this release, apply migration
`20260922200000_subscription_bulk_edit` using the MAM credential wrapper and
`scripts/deploy-subscription-bulk-edit.py apply <reviewed-sha256>`. Run its
`inspect` and `advisors` commands, merge the reviewed GitHub PR into `main`, and
verify the resulting Vercel production deployment. `tests/subscription-bulk.sql`
uses only a disposable database and synthetic records.

### Directory team classifications

Team choices are Operation & Accounts, Management, Major, Minor, Warehouse and Equipsy. Apply the
reviewed label migration using the MAM Supabase credential wrapper with
`scripts/deploy-five-employee-teams.py inspect` then `apply <reviewed-sha256>`
before merging the UI release. Unknown non-empty legacy categories abort the
transaction for review; unknown archived teams remain null. The label backfill
audit records changed field names only. Check-in rescheduling is suppressed only
inside the backfill transaction and restored before commit. It does not change
Company, Reports to, roles, approvals, leave balances or calendar permissions.
Apply `20260930120000_rename_mam_admin_team.sql` before releasing the renamed
UI: it updates existing MAM admin labels and the team constraint, then scopes
Calendar and limited Directory peers by their nearest active Manager
in the reporting tree, across non-manager people and structural org units but
within one company. A missing
manager yields no peers; changing or clearing Team never changes access. Managers
retain approved leave visibility across both companies and submitted/approved
leave for their active reporting descendants. Explicit payroll
calendar grants retain their separate approved-leave scope. Calendar peer rows
remain category-minimised and never expose reasons. Historical team-scoped leave
approval grants are inert in the effective resolver; active manager-subtree and
global approval grants continue unchanged. The full disposable SQL replay and
`tests/reporting-calendar-scope.sql` verify these boundaries; no staff is assigned
to Management by this migration.
