# Project brief

## Outcome

Give MAM employees, managers and accounts one reliable place to see leave, coverage and approval state before the working day starts, while giving HR and Team Leaders a synthetic preview of onboarding, offboarding and check-in workflows.

## Phase 1

- Establish the private web application, repository, deployment and database boundaries.
- Validate the complete leave workflow through an interactive synthetic-data demo.
- Add password access only after management approves the demonstrated workflow.
- Model employees, teams and employee-owned leave requests with RLS.
- Validate employee submission, manager decisions, dashboard language and coverage visibility with management using synthetic data.
- Demonstrate People workflow checklists, asset/access visibility and manager check-in reminders using synthetic browser-local data. Recruitment is excluded.

## Current demo boundary

- The demo contains no real employee records.
- Shared Leave demo mode can write only the fixed synthetic Leave dataset to Supabase and share it in realtime across browsers. It remains separate from the People workspace.
- Onboarding, Offboarding and Check-ins are browser-local synthetic workflows: their cases, selected evidence/uploads, asset/access changes, audit entries and reminder/email previews reset on refresh or Reset demo and do not write to Supabase.
- Employee profile previews show their own onboarding and check-ins, not offboarding. About me uses the selected synthetic profile to demonstrate tenure, milestone treatment and support contacts; it does not use real employee details.
- The top-right selector contains synthetic HR, Major Mod manager, Minor Mod manager and employee profiles for demonstrating role-based visibility; this is not authentication or a production identity system.
- The CRM-style Home, calendar and activity views are presentation surfaces around the demo data, not separate production data stores; the People workflow boundary is described above.
- Approval and decline actions demonstrate the intended state changes but are not production decisions.
- People task changes and reminder previews are illustrative only: they do not create accounts, provision/revoke external access, schedule jobs or send email.

## Not yet in scope

- Payroll or award interpretation.
- Automatic approval.
- Writing leave into AroFlo, Outlook calendars, payroll or another production system.
- Exposing leave reasons to coworkers.
- Production notifications before recipients and templates are approved.
- Recruitment automation.

## Definition of done for the foundation

- Private MAM GitHub repository has a recoverable main branch.
- MAM Supabase project/branch is linked and the migration passes security advisors.
- MAM Vercel project has separate development, preview and production variables.
- `npm run check` passes.
- A synthetic-user preview is approved by the HR lead and system owner.
- Live workflow decisions in `business-rules.md` are resolved before staff data is loaded.
