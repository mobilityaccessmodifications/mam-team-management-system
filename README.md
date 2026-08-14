# Safer People System

Safer People System is the private people portal for Mobility Access Modifications (MAM) and Equipsy. It combines the live organisation directory, account administration, leave visibility and essential people workflows in one minimal workspace. Recruitment is excluded.

## Current status

- Frontend: Next.js 16 App Router, React 19 and TypeScript
- Hosting: the MAM-owned Vercel project at `https://mam-team-management-system-ten.vercel.app`
- Source: `mobilityaccessmodifications/mam-team-management-system`
- Data and authentication: MAM Supabase project `xtwlrjqbusadghavchqm`
- Directory: the live MAM and Equipsy roster, with a private one-to-one HR employee-detail store; there is no demo-role or profile switcher
- Accounts: username/password login backed by Supabase Auth and a database-controlled account registry
- Workflow review: leave, onboarding, offboarding and check-in records are created in the open browser session using people from the real directory; they are not yet durable staff records

MAM people use the orange accent and Equipsy people use blue. Company is also stated in text, so colour is never the only company indicator.

## What works now

After login, the server verifies that the Supabase Auth user is linked to an active directory person. Every employee can use the live organisation tree, search it, and open a selected person’s work email. The tree does not expose a private employee list or private profile fields.

Only a database-authorised HR user receives the master view. HR can:

- create a login for an unlinked directory person;
- view login names, account status and last sign-in time;
- change a login name;
- set a new password; and
- disable or re-enable an account; and
- open the private employee Directory, add or edit a person, and export the approved employee CSV.

The **Directory** is HR-only and is the single employee editor. It contains the complete employee list and the private contact and employment fields needed by HR, such as work and personal contact details, phone number and date of birth. Employees never receive this list, these details, the CSV export or the Accounts view. The employee CSV is separate from portal accounts: it never includes login names, Auth addresses or passwords.

Supabase Auth stores passwords as non-reversible hashes. HR can set a replacement password and see that newly generated value once, but neither the application nor HR can retrieve an existing password.

The Leave workspace demonstrates full-day and timed leave across one or more dates, sick leave, optional PDF/image evidence, manager decisions, a review calendar spanning three weeks before and after a request, direct manager leave entries and a privacy-preserving team calendar. Times are limited to 6:00 am–6:00 pm in 15-minute intervals. Current leave requests, decisions and uploaded files exist only for the active browser session and use real directory people; refreshing clears them.

The People workspace uses the real directory only for creating onboarding, offboarding and check-in workflow examples. No cases, reminders, contacts or employees are pre-seeded. Workflow task changes, evidence indicators and check-in records are browser-session state only and do not provision accounts, revoke external access, schedule reminders or send email.

## Data boundaries

- Real names, positions, companies and reporting relationships live only in the authenticated, RLS-protected Supabase directory. Every authenticated employee may use the organisation tree, which exposes the safe name, position, company and reporting relationship and, only when a person is selected, that person’s work email.
- HR employee details live in a private one-to-one record linked to the organisation person. Only HR-authorised database functions may return the complete employee list or private fields such as phone number, personal email and date of birth; the private roster is never committed to Git or copied into fixtures.
- The HR CSV export has the exact 12 employee columns in the agreed order—First Name, Last Name, Work Email, Personal Email, Phone, Job Title, Team, Manager, Country, Date of birth, Start date and Scheduled Employment End Date—and contains no portal-account or credential data. It is generated only for an authorised HR session and is not stored in Git.
- The employee editor writes the canonical organisation fields and broadcasts committed changes through Realtime, so the safe organisation tree updates in other authorised sessions.
- A supplied HR workbook is staged and reconciled before import. It is never an instruction to automatically replace identities, deactivate people or relink existing accounts.
- Account links, normalised login names, status and audit metadata live in Supabase. The Accounts view and account-management actions are HR-only. Supabase Auth remains the only password store.
- Leave and People workflow examples are non-durable browser-session records until their live business rules and RLS design are approved.
- Private leave reasons and evidence are never shown in the shared calendar.
- No email notification route or review-mailbox transport is active in the application.

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
| `NEXT_PUBLIC_APP_URL` | Browser-safe | Exact application origin used for in-app links |

`SUPABASE_SECRET_KEY` must never use a `NEXT_PUBLIC_*` name, enter client code, appear in logs or be committed. Production keeps it only in the MAM Vercel project's encrypted Production environment. Login passwords are not application environment variables.

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
6. Test login, active/disabled account enforcement, HR-only account and Directory access, the employee-only organisation-tree work-email view, and browser-session workflow privacy.
7. Deploy without changing the established production URL.
