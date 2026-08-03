# MAM Team Management System

An internal web portal for Mobility Access Modifications to manage team availability, leave requests and manager decisions.

The repository currently contains a deployable foundation and a safe, synthetic dashboard preview. Supabase and production staff data are deliberately not connected until MAM confirms the workflow and the correct MAM accounts are available.

## Status

- Phase: foundation
- First product area: leave management
- Frontend: responsive dashboard and passwordless sign-in flow
- Database: initial RLS-first migration, not applied to a remote project
- GitHub: local repository only; MAM GitHub account is not authenticated yet
- Vercel: not linked; the connected account is not a MAM team
- Supabase: not linked; the connected organization is not a MAM organization

## Stack

- Next.js 16 App Router, React 19, TypeScript
- Supabase Auth and Postgres
- Vercel hosting and environment separation
- npm with committed lockfile and pinned application dependencies

## Local preview

The synthetic dashboard can build and render without a Supabase connection:

```bash
npm ci
npm run dev
```

Open `http://localhost:3000`.

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
