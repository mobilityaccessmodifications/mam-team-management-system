# Architecture

## System boundary

```text
Browser
  -> Vercel / Next.js
       -> Shared synthetic demo: Supabase Postgres + Realtime (publishable key)
       -> Production-only synthetic email route
            -> n8n authenticated webhook
                 -> Microsoft Outlook - ai@mobilityaccess.com.au
                      -> ai@mobilityaccess.com.au only
       -> Future live system: Supabase Auth + Postgres RLS
```

No external HR, payroll or AroFlo write integration exists in the foundation phase. The only approved external write is the narrowly scoped synthetic email-review transport described below; it is not a live staff notification integration.

## Synthetic email-review transport

- The browser keeps a non-durable Email activity log for display, but the log is not the delivery source of truth and disappears on refresh or Reset demo.
- The delivery endpoint is a production-only Next.js server route. It accepts only supported synthetic event identifiers and derives employee name, leave type, dates/times, reason and decision state from the canonical synthetic Supabase row rather than trusting browser-supplied email content.
- Separate intended-recipient templates remain for Team Leader review, employee decline, and employee/HR/Accounts approval messages. Every physical message is nevertheless hard-locked in server code and in n8n to `ai@mobilityaccess.com.au`; no real employee, manager, HR or Accounts address is used.
- The Team Leader template links to `https://mam-team-management-system-ten.vercel.app` for review. The Accounts template excludes the request reason and manager note. Supporting files and attachment links are never included in email.
- The route calls an authenticated n8n webhook. n8n sends through the credential named `Microsoft Outlook - ai@mobilityaccess.com.au`. The only application-side credentials are the server-only `MAM_N8N_LEAVE_WEBHOOK_URL` and `MAM_N8N_LEAVE_WEBHOOK_SECRET`, gated by `MAM_DEMO_EMAIL_ENABLED`.
- Check-in reminder delivery is accepted only for fixed synthetic reminder fixtures on a server allowlist. Browser-created or edited reminder content cannot be sent.
- Leave persistence and email delivery are deliberately not one transaction. A request or decision remains saved if n8n or Outlook fails; the UI may report or log the delivery failure without reverting the leave state.
- This transport adds no database migration, authentication, real employee addresses or production HR data.

## Current shared demo

- `demo_profiles` and `demo_leave_requests` contain fixed synthetic records only.
- Browsers may read those records through RLS and subscribe to Postgres Changes.
- Direct anonymous inserts, updates and deletes are revoked. Narrow `security definer` RPCs validate a fixed synthetic profile, working-window times, manager assignment, employee request status and reset confirmation before changing demo rows. Manager profiles create approved records with `approval_required = false`; employee profiles create pending records assigned to their manager.
- The public RPCs are an intentional demo-only compromise so the workflow can be tested before authentication. They are not an authorization model and must never be used with real employee data.
- If the shared demo variables are absent, the application falls back to browser-local synthetic data.
- Supporting files are a browser-session interaction in this no-login demo and disappear on refresh or reset. They are deliberately not written to the anonymous shared dataset because the profile selector is not an identity or authorization boundary.
- Email activity entries are browser-only, non-durable synthetic display state and are cleared by Reset demo. When production review delivery is enabled, the server independently rebuilds approved message content from the canonical synthetic Supabase record; provider credentials and attachment links never enter browser state.
- The separate People workspace (Onboarding, Offboarding and Check-ins; no Recruitment) is entirely browser-local synthetic state. Its cases, task progress, selected evidence filenames/uploads, asset/access register, audit entries and reminder previews are not part of `demo_profiles` or `demo_leave_requests`, do not use Supabase Realtime and disappear on refresh or Reset demo.
- The People workspace's My profile panel is also browser-local synthetic state. It receives only the selected demo profile's fixed role, team, manager and start-date fixture, derives tenure in the client, and lists essential `example.test` support contacts; it is not an employee directory or a security boundary.
- Check-in reminders are calculated in the client from synthetic start dates and always create in-app preview activity. The production email route may deliver only an exact, fixed server-allowlisted synthetic reminder fixture to the review mailbox; there is no scheduler/cron, external provisioning or deprovisioning integration, and no new Supabase migration for People operations.

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

People operations tables are intentionally not yet modelled. A future authenticated design will need separately authorised workflow, task, evidence, asset, access/subscription, audit, employee check-in and reminder records, plus server-side scheduling and provider secrets if actual notifications are approved.

The staff/auth attachment migration allows an employee to upload evidence for their own open request, while only HR, system administrators, and a manager/team lead who shares the employee's team may read the attachment metadata or file object. Access is checked from controlled profile and membership records, never user-editable metadata.

## Environments

- Development: synthetic users/data, local `.env.local`, development Supabase project or branch.
- Preview: Vercel branch deployment and isolated/non-production Supabase data.
- Production: MAM-managed accounts and approved policies only.

Production secrets are never copied into development to make setup easier.
