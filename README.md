# MAM Team Management System

An internal web portal for Mobility Access Modifications to manage team availability, leave requests and manager decisions.

The repository currently contains a deployable foundation and an interactive, synthetic workflow demo. It demonstrates full-day and partial-day leave requests, sick leave, manager approval with a coverage calendar spanning three weeks before and after each request, and a privacy-preserving team calendar without authentication or real staff data.

## Status

- Phase: interactive workflow demo
- First product area: leave management
- Frontend: responsive, CRM-style operations workspace with browser-local demo state
- Authentication: deliberately deferred for the demo
- Demo data: synthetic and reset on refresh; no staff information is stored
- Database: initial RLS-first migration, not applied to a remote project
- GitHub: local repository only; no remote is configured for the demo
- Vercel: MAM-owned team available; no project is linked for the demo
- Supabase: MAM organization and development project available; deliberately not linked to the demo

## Stack

- Next.js 16 App Router, React 19, TypeScript
- Supabase Auth and Postgres
- Vercel hosting and environment separation
- npm with committed lockfile and pinned application dependencies

## Local demo

The interactive demo can build and render without a Supabase connection:

```bash
npm ci
npm run dev -- -p 3001
```

Open `http://localhost:3001`.

Use the top-right profile selector to preview the workspace as HR, the Major Mod manager, the Minor Mod manager or several employees. The intentionally minimal sidebar contains Home, leave records, manager approvals when relevant, and the team calendar. Approval records show the applicant highlighted in a weekly calendar grid, relevant team leave and a clearly marked synthetic public-holiday example; private reasons never appear there. For part-day leave, an employee can optionally choose a start and end time between 6:00 am and 6:00 pm in fixed 15-minute intervals on one date; the demo calculates the duration. Submissions and decisions stay in memory for the current browser tab only.

## Connected development

1. Create or select the MAM Supabase project.
2. Copy the safe template:

   ```bash
   cp .env.example .env.local
   ```

3. Fill the development project URL and publishable key. Do not add secret/service-role keys to `NEXT_PUBLIC_*` variables.
4. Link the MAM Vercel project, store the same variable names in Vercel's Development environment, then pull them into `.env.local`.
5. Apply and verify the migration only after the business rules in `docs/business-rules.md` are confirmed.

## Verification

```bash
npm run lint
npm run typecheck
npm run build
```

Or run all three:

```bash
npm run check
```

## Environment variables

| Variable | Exposure | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Browser-safe | MAM Supabase API URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Browser-safe | Modern Supabase publishable key; protected by RLS |
| `NEXT_PUBLIC_APP_URL` | Browser-safe | Exact origin used in authentication redirects |
| `MAM_ALLOWED_EMAIL_DOMAIN` | Server-only | Optional work-email allowlist |

See `docs/environment-management.md` for the full model.

## Project documentation

- `AGENTS.md` — AI operating and safety rules
- `docs/project-brief.md` — scope and delivery definition
- `docs/business-rules.md` — confirmed rules and decisions still required
- `docs/architecture.md` — application and data boundaries
- `docs/environment-management.md` — API key and environment strategy
- `docs/decisions/0001-platform.md` — why Next.js, Supabase and Vercel were selected

## Deployment order

1. Authenticate the MAM GitHub owner and create a private repository.
2. Select the MAM Supabase organization, review the quoted project cost, then create the project in Sydney (`ap-southeast-2`) unless MAM requires another region.
3. Review and apply the database migration; run Supabase security and performance advisors.
4. Create/link the MAM Vercel project to the GitHub repository.
5. Add environment variables separately for Development, Preview and Production.
6. Deploy a preview, test sign-in and RLS with synthetic users, then obtain management approval before production.
