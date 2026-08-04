# Project brief

## Outcome

Give MAM employees, managers and accounts one reliable place to see leave, coverage and approval state before the working day starts.

## Phase 1

- Establish the private web application, repository, deployment and database boundaries.
- Validate the complete leave workflow through an interactive synthetic-data demo.
- Add password access only after management approves the demonstrated workflow.
- Model employees, teams and employee-owned leave requests with RLS.
- Validate employee submission, manager decisions, dashboard language and coverage visibility with management using synthetic data.

## Current demo boundary

- The demo runs entirely in the browser and resets on refresh.
- It contains no real employee records and writes nothing to Supabase.
- The top-right selector contains synthetic HR, Major Mod manager, Minor Mod manager and employee profiles for demonstrating role-based visibility; this is not authentication or a production identity system.
- CRM-style record, board, calendar, people and activity views are navigation prototypes, not separate production data stores.
- Approval and decline actions demonstrate the intended state changes but are not production decisions.

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
