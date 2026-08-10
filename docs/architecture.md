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
- Direct anonymous inserts, updates and deletes are revoked. Narrow `security definer` RPCs validate a fixed synthetic profile, working-window times, manager assignment, employee request status and reset confirmation before changing demo rows. Manager profiles create approved records with `approval_required = false`; employee profiles create pending records assigned to their manager.
- The public RPCs are an intentional demo-only compromise so the workflow can be tested before authentication. They are not an authorization model and must never be used with real employee data.
- If the shared demo variables are absent, the application falls back to browser-local synthetic data.
- Supporting files are a browser-session interaction in this no-login demo and disappear on refresh or reset. They are deliberately not written to the anonymous shared dataset because the profile selector is not an identity or authorization boundary.

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
- `leave_request_attachments`: private evidence metadata linked to a leave request; file bytes live in the non-public `leave-evidence` Storage bucket.

The staff/auth attachment migration allows an employee to upload evidence for their own open request, while only HR, system administrators, and a manager/team lead who shares the employee's team may read the attachment metadata or file object. Access is checked from controlled profile and membership records, never user-editable metadata.

## Environments

- Development: synthetic users/data, local `.env.local`, development Supabase project or branch.
- Preview: Vercel branch deployment and isolated/non-production Supabase data.
- Production: MAM-managed accounts and approved policies only.

Production secrets are never copied into development to make setup easier.
