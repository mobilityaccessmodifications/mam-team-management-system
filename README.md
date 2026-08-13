# Safer People System

Safer People System is the private people portal for Mobility Access Modifications (MAM) and Equipsy. It combines the live organisation directory, account administration, leave visibility and essential people workflows in one minimal workspace. Recruitment is excluded.

## Current status

- Frontend: Next.js 16 App Router, React 19 and TypeScript
- Hosting: the MAM-owned Vercel project at `https://mam-team-management-system-ten.vercel.app`
- Source: `mobilityaccessmodifications/mam-team-management-system`
- Data and authentication: MAM Supabase project `xtwlrjqbusadghavchqm`
- Directory: the privately imported MAM and Equipsy roster; no seeded or selectable fake people
- Accounts: username/password login backed by Supabase Auth and a database-controlled account registry
- Workflow review: leave, onboarding, offboarding and check-in records are created in the open browser session using people from the real directory; they are not yet durable staff records

MAM people use the orange accent and Equipsy people use blue. Company is also stated in text, so colour is never the only company indicator.

## What works now

After login, the server verifies that the Supabase Auth user is linked to an active directory person. The authorised administrator receives the master view and can:

- search and edit the live organisation tree;
- preview the interface as another real directory person without impersonating that person's authenticated account;
- create a login for an unlinked directory person;
- view login names, account status and last sign-in time;
- change a login name;
- set a new password; and
- disable or re-enable an account.

Supabase Auth stores passwords as non-reversible hashes. The administrator can set a replacement password and see that newly generated value once, but neither the application nor the administrator can retrieve an existing password.

The Leave workspace demonstrates full-day and timed leave across one or more dates, sick leave, optional PDF/image evidence, manager decisions, a review calendar spanning three weeks before and after a request, direct manager leave entries and a privacy-preserving team calendar. Times are limited to 6:00 am–6:00 pm in 15-minute intervals. Current leave requests, decisions and uploaded files exist only for the active browser session and use real directory people; refreshing clears them.

The People workspace uses the real directory for profiles and for creating onboarding, offboarding and check-in workflow examples. No cases, reminders, contacts or employees are pre-seeded. Workflow task changes, evidence indicators and check-in records are browser-session state only and do not provision accounts, revoke external access, schedule reminders or send email.

## Data boundaries

- Real names, positions, companies and reporting relationships live only in the authenticated, RLS-protected Supabase directory. The private roster is never committed to Git or copied into fixtures.
- Account links, normalised login names, status and audit metadata live in Supabase. Supabase Auth remains the only password store.
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
6. Test login, active/disabled account enforcement, account administration, organisation RLS and browser-session workflow privacy.
7. Deploy without changing the established production URL.
