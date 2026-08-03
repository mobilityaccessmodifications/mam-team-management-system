# Architecture

## System boundary

```text
Browser
  -> Vercel / Next.js
       -> Supabase Auth (publishable key)
       -> Supabase Postgres (RLS evaluates the signed-in user)
```

No external HR, payroll, AroFlo or Outlook write integration exists in the foundation phase.

## Authentication

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

The initial policies intentionally expose only a user's own profile, memberships, requests and request events. Manager access is deferred until the approval model is confirmed.

## Environments

- Development: synthetic users/data, local `.env.local`, development Supabase project or branch.
- Preview: Vercel branch deployment and isolated/non-production Supabase data.
- Production: MAM-managed accounts and approved policies only.

Production secrets are never copied into development to make setup easier.
