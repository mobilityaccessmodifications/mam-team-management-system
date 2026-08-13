# Safer People System

An internal people portal for Mobility Access Modifications (MAM) and Equipsy. It brings team availability, leave requests, manager decisions, people workflows and the organisation directory into one private workspace.

The repository contains a deployable foundation and an interactive synthetic workflow demo. It demonstrates full-day and timed leave across one or more dates, sick leave, optional PDF/image evidence, manager approval of employee requests with a coverage calendar spanning three weeks before and after each request, direct manager leave entries, synthetic email previews with an approved production-only review-delivery path, and a privacy-preserving team calendar. It also includes a browser-local People workspace for synthetic onboarding, offboarding and employee check-ins, plus an embedded My profile panel with tenure and essential synthetic support contacts. Recruitment is deliberately excluded.

An authenticated organisation directory is a separate data boundary. It contains only the name, position, company and reporting relationship needed to render the MAM and Equipsy organisation tree. The real roster is imported privately into Supabase after the target is verified; it is never committed to this repository, used in screenshots, or exposed through the anonymous synthetic-demo tables. MAM profiles use the orange accent and Equipsy profiles use the blue accent. Authorised HR users can add people, update titles and change reporting lines; other signed-in staff receive read-only access.

## Status

- Phase: interactive workflow demo
- Current product areas: leave management, synthetic onboarding/offboarding/check-ins, and an authenticated MAM/Equipsy organisation directory; Recruitment is excluded
- Frontend: responsive, minimal operations workspace with realtime shared Leave demo state, browser-local People workflow state and a separate live organisation tree
- Authentication: Supabase passwordless email sign-in protects the internal directory and its HR editing controls; the workflow profile selector remains a demo tool, not authorization
- Demo data: fixed synthetic profiles and Leave records are stored in the MAM Supabase project; People workflow records remain in the open browser only
- Organisation data: the private Supabase directory stores the minimum real roster fields and is populated outside Git
- Database: the shared demo schema remains isolated from the authenticated, RLS-protected organisation schema
- GitHub: company repository at `mobilityaccessmodifications/mam-team-management-system`
- Vercel: company-owned project linked to the `main` branch
- Supabase: MAM organization project connected with browser-safe publishable credentials only
- Email review transport: an optional production-only Next.js-to-n8n path for synthetic messages; n8n sends through `Microsoft Outlook - ai@mobilityaccess.com.au`, and every delivered message is hard-routed to `ai@mobilityaccess.com.au`

## Stack

- Next.js 16 App Router, React 19, TypeScript
- Supabase Auth, Postgres and private Storage
- Vercel hosting and environment separation
- n8n and the MAM AI Outlook mailbox for approved synthetic email-review delivery
- npm with committed lockfile and pinned application dependencies

## Local demo

The interactive demo can build and render without a Supabase connection:

```bash
npm ci
npm run dev -- -p 3001
```

Open `http://localhost:3001`.

Use the top-right profile selector to preview the workspace as HR, the Major Mod manager, the Minor Mod manager or several employees. The intentionally minimal sidebar contains Home, one Leave workspace, the team calendar and People. For managers, Leave contains a clear in-page switch between team requests and the items waiting for their decision; employees only see their own leave. “Pending” counts every pending employee request visible in the current request list, while “To approve” counts only employee requests assigned to the current manager. Managers add their own leave directly to the calendar as approved records and never approve themselves. Approval records show the applicant highlighted in a weekly calendar grid, relevant team leave and a clearly marked synthetic public-holiday example; private reasons never appear there. A person can optionally choose a start time for the first date and an end time for the last date between 6:00 am and 6:00 pm in fixed 15-minute intervals; the demo totals only weekday working-window hours between them.

The private organisation directory is not available in the disconnected local fallback. When Supabase Auth and the authenticated organisation schema are configured, signed-in staff can search the live MAM and Equipsy tree. Directory cards intentionally show only a person's name and position. Editing is checked against the HR allowlist in the database; choosing an HR-looking demo profile never grants write access. Realtime updates are shared with other signed-in viewers.

A request can include up to three PDF or image files of 5 MB each. Files stay only in the open browser session during the no-login demo, disappear on refresh or reset, and are shown only when the profile selector is set to a manager or HR. “Email activity” remains a browser-local, non-durable log of the separate intended Team Leader, employee, HR and Accounts notifications. When the approved production-only transport is enabled, a Next.js server route rebuilds the message from the canonical synthetic Supabase row and asks n8n to send it through `Microsoft Outlook - ai@mobilityaccess.com.au`. Every physical delivery is hard-locked to `ai@mobilityaccess.com.au`; no real employee address is used. Team Leader messages link to the fixed production site, Accounts messages exclude the request reason and manager note, and no attachment is emailed. A transport failure is reported separately and never rolls back a saved request or decision. This is an honest synthetic workflow review, not a security boundary. The versioned staff/auth migration creates a private Supabase Storage bucket and RLS-backed metadata for real manager/HR-only access once authenticated identities are enabled.

When `NEXT_PUBLIC_SHARED_DEMO=true` and the public Supabase variables are configured, submissions, decisions and resets are shared in realtime across open browsers. “Reset demo” restores the fixed fake dataset for everyone. The profile selector remains a role simulation, not authentication, so this mode must never contain real staff or leave data.

The People workspace combines a compact My profile panel with role-specific lifecycle and check-in views. Employees see only their own check-ins. A single lifecycle tab appears only when assigned—My onboarding or Offboarding—and contains only their Employee-owned actions; employees without an active workflow see neither tab. Other employees' offboarding and all HR, IT, manager, asset, access and audit details remain hidden from employee views. Relevant managers see their assigned workflows, while HR can open supporting asset, access and activity details when needed. Its Check-ins tab uses the current schedule of 2 weeks, 1 month, 3 months and 5-month probation; prompts are due 3 days, 4 business days, 2 weeks, and 2 weeks plus a final 1 week before the respective check-in. Running a due reminder always adds an in-app preview; actual review-mailbox delivery is permitted only for fixed synthetic reminder fixtures on the server allowlist when the production transport is enabled. My profile derives a synthetic tenure from the selected profile, can show a subtle anniversary treatment on a configured demo date, and lists only synthetic manager, People and IT contacts. People/profile cases, selected evidence/upload state and reminder activity are browser-local, clear on reset or refresh, and do not create accounts or provision/revoke access.

## Connected development

1. Select the verified MAM Supabase project.
2. Copy the safe template:

   ```bash
   cp .env.example .env.local
   ```

3. Fill the development project URL and publishable key, then set `NEXT_PUBLIC_SHARED_DEMO=true`. Do not add secret/service-role keys to `NEXT_PUBLIC_*` variables.
4. Store the same browser-safe variables in the verified MAM Vercel project for Development, Preview and Production.
5. Apply schema changes only after verifying the exact Supabase profile and project. Import any approved real organisation roster directly into the authenticated production table, never through a committed migration or fixture.

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
| `MAM_ALLOWED_EMAIL_DOMAINS` | Server-only | Required comma-separated work-email domain allowlist; login fails closed when absent |
| `MAM_DEMO_EMAIL_ENABLED` | Server-only | Enables the production-only synthetic review-email transport when set to `true` |
| `MAM_N8N_LEAVE_WEBHOOK_URL` | Server-only | n8n webhook URL used only by the approved synthetic email route |
| `MAM_N8N_LEAVE_WEBHOOK_SECRET` | Server-only | Shared secret used to authenticate the server-to-server n8n request |
| `MAM_SUPABASE_AUTH_HOOK_SECRET` | Server-only | Standard Webhooks signing secret shared only with the Supabase Send Email Hook |
| `MAM_N8N_AUTH_EMAIL_WEBHOOK_URL` | Server-only | Dedicated MAM n8n endpoint for verified six-digit authentication emails |
| `MAM_N8N_AUTH_EMAIL_WEBHOOK_SECRET` | Server-only | Dedicated secret authenticating the Vercel-to-n8n authentication-email request |

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
6. Keep `MAM_DEMO_EMAIL_ENABLED` disabled in Development and Preview. For an approved Production test, configure the server-only n8n values, verify the n8n sender is `Microsoft Outlook - ai@mobilityaccess.com.au`, and verify its recipient remains hard-locked to `ai@mobilityaccess.com.au`.
7. Deploy a preview, test sign-in and RLS with synthetic users, then obtain management approval before production.
