# Project brief

## Outcome

Give MAM employees, managers and accounts one reliable place to see leave, coverage and approval state before the working day starts.

## Phase 1

- Establish the private web application, repository, deployment and database boundaries.
- Provide passwordless work-email authentication.
- Model employees, teams and employee-owned leave requests with RLS.
- Validate the dashboard language and coverage view with management using synthetic data.

## Not yet in scope

- Payroll or award interpretation.
- Automatic approval.
- Writing leave into AroFlo, Outlook calendars, payroll or another production system.
- Exposing leave reasons to coworkers.
- Production notifications before recipients and templates are approved.

## Definition of done for the foundation

- Private MAM GitHub repository has a recoverable main branch.
- MAM Supabase project/branch is linked and the migration passes security advisors.
- MAM Vercel project has separate development, preview and production variables.
- `npm run check` passes.
- A synthetic-user preview is approved by the HR lead and system owner.
- Live workflow decisions in `business-rules.md` are resolved before staff data is loaded.
