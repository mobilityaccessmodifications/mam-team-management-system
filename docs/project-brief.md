# Project brief

## Outcome

Give MAM and Equipsy staff one private, minimal Safer People System for the organisation tree, leave visibility and essential people workflows.

## Phase 1

- Establish the private web application, repository, deployment and database boundaries.
- Validate the complete leave workflow through an interactive synthetic-data demo.
- Add one pre-provisioned Supabase Auth username/password administrator account for review. Its password is managed only in Supabase Auth and is never stored in source or environment variables.
- Model employees, teams and employee-owned leave requests with RLS.
- Validate employee submission, manager decisions, dashboard language and coverage visibility with management using synthetic data.
- Validate the leave notification workflow through a production-only synthetic email-review path that sends every physical message to `ai@mobilityaccess.com.au`.
- Demonstrate People workflow checklists, asset/access visibility and manager check-in reminders using synthetic browser-local data. Recruitment is excluded.
- Add an authenticated, minimal organisation directory for MAM and Equipsy. The current authorised administrator can read and edit the live tree; any later ordinary-staff access requires separately approved account and authorisation rules.

## Current demo boundary

- The demo contains no real employee records.
- Real organisation names and positions are a separate authenticated dataset imported privately into Supabase after the target is verified. They are never committed to Git or copied into the synthetic workflow tables.
- Shared Leave demo mode can write only the fixed synthetic Leave dataset to Supabase and share it in realtime across browsers. It remains separate from the People workspace.
- Onboarding, Offboarding and Check-ins are browser-local synthetic workflows: their cases, selected evidence/uploads, asset/access changes, audit entries and reminder/email previews reset on refresh or Reset demo and do not write to Supabase. Only a fixed server-allowlisted synthetic check-in reminder fixture may use the production review-mailbox transport.
- Employee profile previews show only their own check-ins and, when active, their own Employee-owned onboarding or offboarding actions in one context-sensitive lifecycle tab. Employees without an active workflow see no lifecycle tab; employee views never expose another employee's offboarding or HR, IT, manager, asset, access or audit details. The People workspace's My profile panel uses the selected synthetic profile to demonstrate tenure, anniversary treatment and essential support contacts. The separate organisation directory uses only the approved name, title, company and reporting relationship needed for its tree.
- The authenticated administrator lands in the server-verified HR master view. Its top-right View-as selector contains synthetic HR, Major Mod manager, Minor Mod manager and employee profiles for demonstrating role-based visibility; it does not replace the Supabase session, grant permissions or become a production identity system.
- The CRM-style Home, calendar and activity views are presentation surfaces around the demo data, not separate production data stores; the People workflow boundary is described above.
- Approval and decline actions demonstrate the intended state changes but are not production decisions. When production review delivery is enabled, a server route rebuilds the corresponding notification from the canonical synthetic Supabase row and sends it through n8n; a mail failure never rolls back the demonstrated leave state.
- Email activity remains a non-durable browser log. Intended Team Leader, employee, HR and Accounts templates stay separate, but every physical delivery is hard-locked to `ai@mobilityaccess.com.au`. Team Leader messages use the fixed production review link, Accounts never receives the reason or manager note, and no attachment is delivered.
- Administrator password sign-in and the synthetic leave/check-in email-review transport are separate boundaries; the review transport remains unchanged.
- People task changes and reminder previews are illustrative only: they do not create accounts, provision/revoke external access or schedule jobs. Only fixed synthetic reminder fixtures on the server allowlist may be delivered to the review mailbox.

## Not yet in scope

- Payroll or award interpretation.
- Automatic approval.
- Writing leave into AroFlo, Outlook calendars, payroll or another production system.
- Exposing leave reasons to coworkers.
- Live staff notifications, real recipient addresses and non-synthetic email content. The approved review transport is limited to synthetic templates delivered only to `ai@mobilityaccess.com.au`.
- Recruitment automation.

## Definition of done for the foundation

- Private MAM GitHub repository has a recoverable main branch.
- MAM Supabase project/branch is linked and the migration passes security advisors.
- MAM Vercel project has separate development, preview and production variables.
- `npm run check` passes.
- A synthetic-user preview is approved by the HR lead and system owner.
- Live workflow decisions in `business-rules.md` are resolved before staff data is loaded.
