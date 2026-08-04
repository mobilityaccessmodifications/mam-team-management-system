# Architecture

## System boundary

```text
Browser
  -> Vercel / Next.js
       -> Shared synthetic demo: Supabase Postgres + Realtime (publishable key)
       -> Future live system: Supabase Auth + Postgres RLS
```

No external HR, payroll, AroFlo or Outlook write integration exists in the foundation phase.

## Current shared demo

- `demo_profiles` and `demo_leave_requests` contain fixed synthetic records only.
- Browsers may read those records through RLS and subscribe to Postgres Changes.
- Direct anonymous inserts, updates and deletes are revoked. Narrow `security definer` RPCs validate a fixed synthetic profile, manager assignment, request status and reset confirmation before changing demo rows.
- The public RPCs are an intentional demo-only compromise so the workflow can be tested before authentication. They are not an authorization model and must never be used with real employee data.
- If the shared demo variables are absent, the application falls back to browser-local synthetic data.

## Future authentication

- Passwordless email sign-in through Supabase Auth.
- Next.js `src/proxy.ts` refreshes auth cookies and performs only an optimistic redirect.
- Server Actions and RLS remain responsible for authorization.
- The server validates claims with `getClaims()`; it does not trust an unvalidated session cookie.

## Data model

- `profiles`: employee identity and controlled application role.
- `teams`: business teams.
- `team_memberships`: employee-to-team relationship and team role.
- `leave_requests`: employee-owned request with dates and lifecycle state.
- `leave_request_events`: audit-friendly request history.

The unapplied staff/auth migration intentionally exposes only a user's own profile, memberships, requests and request events. Manager access is deferred until the approval model is confirmed.

## Environments

- Development: synthetic users/data, local `.env.local`, development Supabase project or branch.
- Preview: Vercel branch deployment and isolated/non-production Supabase data.
- Production: MAM-managed accounts and approved policies only.

Production secrets are never copied into development to make setup easier.
