# MAM Team Management System

An internal web portal for Mobility Access Modifications to manage team availability, leave requests and manager decisions.

The repository currently contains a deployable foundation and an interactive, shared synthetic workflow demo. It demonstrates full-day and timed leave across one or more dates, sick leave, manager approval of employee requests with a coverage calendar spanning three weeks before and after each request, direct manager leave entries, and a privacy-preserving team calendar without authentication or real staff data.

## Status

- Phase: interactive workflow demo
- First product area: leave management
- Frontend: responsive, CRM-style operations workspace with realtime shared demo state
- Authentication: deliberately deferred for the demo
- Demo data: fixed synthetic profiles and leave records stored in the MAM Supabase project
- Database: a shared demo schema with RLS, constrained RPCs and Postgres Changes; the future staff/auth schema remains unapplied
- GitHub: company repository at `mobilityaccessmodifications/mam-team-management-system`
- Vercel: company-owned project linked to the `main` branch
- Supabase: MAM organization project connected with browser-safe publishable credentials only

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

Use the top-right profile selector to preview the workspace as HR, the Major Mod manager, the Minor Mod manager or several employees. The intentionally minimal sidebar contains Home, one Leave workspace and the team calendar. For managers, Leave contains a clear in-page switch between team requests and the items waiting for their decision; employees only see their own leave. “Pending” counts every pending employee request visible in the current request list, while “To approve” counts only employee requests assigned to the current manager. Managers add their own leave directly to the calendar as approved records and never approve themselves. Approval records show the applicant highlighted in a weekly calendar grid, relevant team leave and a clearly marked synthetic public-holiday example; private reasons never appear there. A person can optionally choose a start time for the first date and an end time for the last date between 6:00 am and 6:00 pm in fixed 15-minute intervals; the demo totals only weekday working-window hours between them.

When `NEXT_PUBLIC_SHARED_DEMO=true` and the public Supabase variables are configured, submissions, decisions and resets are shared in realtime across open browsers. “Reset demo” restores the fixed fake dataset for everyone. The profile selector remains a role simulation, not authentication, so this mode must never contain real staff or leave data.

## Connected development

1. Select the verified MAM Supabase project.
2. Copy the safe template:

   ```bash
   cp .env.example .env.local
   ```

3. Fill the development project URL and publishable key, then set `NEXT_PUBLIC_SHARED_DEMO=true`. Do not add secret/service-role keys to `NEXT_PUBLIC_*` variables.
4. Store the same browser-safe variables in the verified MAM Vercel project for Development, Preview and Production.
5. Apply only the shared synthetic demo migrations. Do not apply the future staff/auth migration until the business rules in `docs/business-rules.md` are confirmed.

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
| `NEXT_PUBLIC_SHARED_DEMO` | Browser-safe | Enables the shared synthetic dataset and realtime subscription |
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

1. Confirm the MAM GitHub repository and its default branch are the intended deployment source.
2. Select the MAM Supabase organization, review the quoted project cost, then create the project in Sydney (`ap-southeast-2`) unless MAM requires another region.
3. Review and apply the database migration; run Supabase security and performance advisors.
4. Confirm the MAM Vercel project remains linked to the GitHub repository.
5. Add environment variables separately for Development, Preview and Production.
6. Deploy a preview, test sign-in and RLS with synthetic users, then obtain management approval before production.
