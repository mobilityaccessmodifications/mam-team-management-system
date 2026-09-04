# Safer People System

Safer People System is the private people portal for Mobility Access Modifications (MAM) and Equipsy. It combines the live organisation directory, account administration, leave visibility and essential people workflows in one minimal workspace. Recruitment is excluded.

## Current status

- Frontend: Next.js 16 App Router, React 19 and TypeScript
- Hosting: the MAM-owned Vercel project at `https://mam-team-management-system-ten.vercel.app`
- Source: `mobilityaccessmodifications/mam-team-management-system`
- Data and authentication: MAM Supabase project `xtwlrjqbusadghavchqm`
- Directory: the live MAM and Equipsy roster, with a private one-to-one HR employee-detail store; there are no demo roles, every active linked employee has a limited top-right self-service profile, and an authorised HR administrator may select a real employee view from the sidebar
- Accounts: username/password login backed by Supabase Auth and a database-controlled account registry
- Leave rollout: durable leave migration `20260817120000_persist_leave_workspace` is applied to the verified MAM production project and the matching application is deployed at the fixed production URL. Leave requests and decisions now persist through controlled, RLS-protected operations.
- Check-ins: active employees receive an automatic, durable milestone schedule; onboarding and offboarding remain separate review work

MAM people use the orange accent and Equipsy people use blue. Company is also stated in text, so colour is never the only company indicator.

The current live reporting baseline places all active Team Leaders under the MAM Director. Minor Mods is grouped beneath its Team Leader into Scheduling team, Estimating team, Trades team, Admin team and an intentionally empty CSO team; these are safe structural organisation nodes, not private employee records.

## What works now

After login, the server verifies that the Supabase Auth user is linked to an active directory person. Every employee can use the live organisation tree, search it, and open a selected person’s work email. The tree does not expose a private employee list or private profile fields.

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

The deployed Leave workspace supports full-day and timed leave across one or more dates, sick leave, manager decisions and a privacy-preserving team calendar. Times are limited to 6:00 am–6:00 pm in 15-minute intervals. Authenticated requests and decisions are stored through the controlled leave operations and refresh across authorised accounts.

Migrations `20260817120000_persist_leave_workspace`, `20260818130000_configurable_leave_approval_grants` and `20260824170000_manager_based_leave_approval` are applied to the verified MAM production project before the matching application release. Every submitted request starts **Pending**: there is no automatic approval or self-approval. The database uses the active `manager` role and reporting tree to route each request to the nearest manager with approval permission; non-manager employees in between do not intercept it. HR, Penny and Steven remain global reviewers. The database snapshots the authorised reviewers when a request is submitted and re-routes still-pending work when manager permission changes. A global leave-review capability does not grant HR Directory or account access. The shared calendar is for company availability, not a leave-balance ledger; ordinary employee peers see a generic **Away** entry rather than another person’s leave type, reason or evidence. The pending or approved request owner can add up to ten private supporting PDF/image files. Metadata is scoped through controlled database functions, downloads are re-authorised server-side and forced as attachments, and a bounded daily job removes abandoned uploads. Files are not malware-scanned, so the documented HR handling policy remains part of the release boundary.

The paired forward migration `20260818140000_shared_calendar_birthdays` adds the approved birthday exception: every signed-in internal employee sees active MAM and Equipsy birthdays as a name and recurring day/month only—never a birth year or contact data.

Check-in schedules are generated automatically from each active employee's start date. Milestone due dates that fall on Saturday or Sunday move forward to the next Monday-to-Friday working day. The agreed reminder lead time is then measured from that scheduled workday; if the resulting advance notification date falls on a weekend, it moves back to the previous working day. Due tasks appear in the authorised reviewer's Calendar. There is no manual enable or queue step. Todd/HR, Penny and Steven can review all employees; Kieran, Sujant and Serene can review only current descendants in the organisation tree. Manager views exclude HR-private contact and profile fields. Migration history before 1 July 2026 is marked complete rather than queued for catch-up.

## Data boundaries

- Real names, positions, companies and reporting relationships live only in the authenticated, RLS-protected Supabase directory. Every authenticated employee may use the organisation tree, which exposes the safe name, position, company and reporting relationship and, only when a person is selected, that person’s work email.
- HR employee details live in a private one-to-one record linked to the organisation person. Only HR-authorised database functions may return the complete employee list or an arbitrary selected private profile. A separate controlled self-profile response may return an active linked employee’s own phone number, personal email, date of birth and read-only work email; it never accepts a browser-supplied person identifier. The private roster is never committed to Git or copied into fixtures.
- The HR CSV export preserves its 13 agreed employee columns—First Name, Last Name, Work Email, Personal Email, Phone, Job Title, Team, Company, Manager, Country, Date of birth, Start date and Scheduled Employment End Date—then appends the HR-only hardware audit columns: Laptop supplied, Laptop ID, Mouse ID, Keyboard ID and Asset Tags. It contains no portal-account or credential data, is generated only for an authorised HR session and is not stored in Git.
- The HR employee editor writes the canonical organisation fields and broadcasts committed changes through Realtime, so the safe organisation tree updates in other authorised sessions. Self-service contact changes are saved to the same private employee-detail record but do not change the public organisation fields.
- A supplied HR workbook is staged and reconciled before import. It is never an instruction to automatically replace identities, deactivate people or relink existing accounts.
- Account links, normalised login names, status and audit metadata live in Supabase. The Accounts view and account-management actions are HR-only. Supabase Auth remains the only password store.
- Subscription-service login details are separate from portal accounts. When the encrypted credential vault is enabled, it stores only AES-256-GCM ciphertext and key metadata; plaintext is never returned in a list, export or initial page response. A current System Admin has access by role, while any additional credential delegates are selected by the System Admin and receive only the credential catalogue, not subscription costs, ownership or member data.
- Durable leave and check-in data persist only through controlled, RLS-protected operations. Onboarding and offboarding review work remains separate from the automatic check-in register.
- Leave approval is an independent private capability. Active linked employees submit their own requests; the nearest active linked `manager` profile in the reporting tree is selected first, with explicit global reviewers retained for all-company oversight. A non-manager employee cannot intercept requests from people below them. Still-pending requests are re-routed when manager permission changes, and no reviewer, including an HR or global reviewer, may decide their own request.
- Private leave types, reasons and evidence are never shown in the shared calendar. Ordinary employee peers receive only company availability with the generic label **Away**.
- Calendar birthdays are a deliberately narrow exception to the private date-of-birth boundary. A signed-in internal employee may receive only an active employee’s name and recurring month/day across MAM and Equipsy; no birth year, identifier, company, team or contact field is returned.
- Leave entries remain an availability view rather than a balance ledger; role-scoped check-in tasks are a separate Calendar entry type. Penny must identify the authoritative leave-balance source before the system presents any balance or entitlement information.
- Check-in reminder email delivery is limited to the automatically calculated manager schedule and approved resource links.
- Leave submission and cancellation notifications are routed to the request's server-resolved nearest active manager/admin; approval and decline notifications are routed to every HR-recorded employee address (Work and Personal, when present), with duplicate addresses removed. Every leave notification CCs `hr@mobilityaccess.com.au`; approved and cancelled leave notifications additionally CC `accounts@mobilityaccess.com.au`. The browser cannot choose a recipient; the receiver validates the signed payload and deduplicates repeated event deliveries.
- Production reminder dispatch runs daily at 08:00 Australia/Melbourne through the MAM n8n scheduler, which calls the `CRON_SECRET`-protected People System endpoint. The endpoint accepts claims during the Melbourne 08:00–16:59 window. Check-in reminders are sent to the server-resolved manager/admin and CC `hr@mobilityaccess.com.au`. Vercel Cron is not used for check-in reminder dispatch; it runs only the bounded daily private attachment cleanup declared in `vercel.json`.

## Local development

Use a development Supabase project or branch. Do not copy production secrets into local development.

```bash
npm ci
cp .env.example .env.local
npm run dev -- -p 3001
```

Open `http://localhost:3001`.

The authenticated portal requires all three Supabase variables shown below. A disconnected local shell is not a substitute for the real directory and account boundary.

## Verification

```bash
npm run check
```

This runs lint, type-checking and the production build.

## Environment variables

| Variable | Exposure | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Browser-safe | Supabase API URL for the selected environment |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Browser-safe | Publishable key constrained by RLS |
| `SUPABASE_SECRET_KEY` | Server-only | Supabase Auth Admin access used by authorised account-management Server Actions |
| `MAM_ANALYTICS_API_KEY` | Server-only | Dedicated bearer key for the read-only server-to-server dashboard API |
| `NEXT_PUBLIC_APP_URL` | Browser-safe | Exact application origin used for in-app links |

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
