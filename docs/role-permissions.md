# Portal roles and permission boundaries

This is the canonical approved permission model. It supersedes historical role labels and employee-specific leave, calendar, check-in and payroll grant descriptions elsewhere in the documentation. The role policy must be enforced by database functions, Server Actions and UI capabilities together; a hidden button is not authorization.

## Four ordinary roles and independent P0

| Capability | Team member (`employee`) | Manager (`manager`) | Account (`account`) | Admin (`admin`) | Super Admin / P0 (`system_admin`) |
|---|---|---|---|---|---|
| Own profile, leave and assigned resources | Own permitted records | Own permitted records | Own permitted records | Own permitted records when linked | Authorized selected-employee workflows |
| Directory | Safe reporting-peer projection | Safe reporting-descendant projection; edit the existing permitted team fields | Safe reporting-peer projection; no other-person edits | Full HR Directory, lifecycle and approved CSV | Full operational access |
| Organisation | No complete chart | Safe complete chart, read-only | No complete chart | View and edit | View and edit |
| Leave register | Own requests | Current assigned/reporting review scope | All retained statuses, notes and existing evidence, read-only | Global operational review | Global operational review |
| Decide another person's leave | No | Current eligible assigned requests | No | Global, subject to no-self-decision | Global, subject to no-self-decision |
| Submit leave on behalf | No | Nearest eligible Manager scope | No | Authorized employees | Authorized employees |
| Calendar | Existing self/approved-peer scope | Reporting-team pending/approved and other active teams' approved scope | All active submitted leave plus retained approved history, with staff leave details | Global operational scope | Global operational scope |
| Birthdays | Own recurring month/day | Own and active reporting descendants | Own recurring month/day | All active recurring month/day | All active recurring month/day |
| Check-in review and completion | No review authority | Active reporting descendants | No review authority | Global operational scope | Global operational scope |
| Work-schedule changes | Own first setup or subsequent reviewed request | Own workflow and current Manager review scope | Own workflow only | Direct administration and authorized review | Direct administration and authorized review |
| Payroll file upload | No | No | Upload, stage and compare only | Controlled staged import | Controlled staged import |
| Write payroll/leave balances and accrual policy | No | No | No | Operational administration | Operational administration |
| Portal account creation, login/password/status changes | No | No | No | Operational administration | Operational administration |
| Asset inventory | Own assigned devices only | Own assigned devices only | Own assigned devices only | Full operational inventory | Full operational inventory |
| Subscription register | Own assigned minimised resources; separate explicit management delegation | Read-only by default; separate management delegation below | Own assigned minimised resources | Full operational management | Full operational management |
| Subscription credential vault | Separate explicit delegation only | Separate explicit delegation only | No | Operational credential access | Operational credential access |
| Role assignment | No | No | No | No | Four ordinary roles only; P0 is not assignable here |
| Change profile | No | No | No | No | Yes; presentation preview, not Auth impersonation |
| Subscription delegate and system/security configuration | No | No | No | No | Yes |
| Confirmed-test identity purge | No | No | No | No | Existing separately approved operator workflow only |

Every ordinary account requires a current active employee link. Disabled accounts, archived/inactive employees, invalid sessions and unknown/legacy roles fail closed. Existing standalone P0 accounts remain independent of the employee roster. Role editing must not change their login, Auth identity or P0 authorization.

## Roles are not a simple inheritance ladder

Account and Manager have different responsibilities. Account may inspect the approved operational leave information for payroll, but never inherits Manager decisions, team editing or check-in review. Manager receives only current record/reporting scope rather than company-wide approval merely because of the role. Team, job title, company, asset ownership and subscription membership do not confer a role.

An Account may view other employees' existing leave notes and evidence under the approved read-only payroll workflow. That sensitive permission must be stated explicitly in the role editor; it is not implied by Calendar access. It does not permit adding/removing evidence, cancelling somebody else's leave, acting on behalf of another employee or deciding a request. Own leave workflows retain their ordinary owner permissions.

## Payroll comparison is not balance-import authority

Every Account receives the same comparison-only workflow. A staged file may show parsed payroll values and differences, but neither the UI, Server Action nor a directly called legacy/new commit RPC may apply those rows to live balances. Source files retain the established private archive and minimum retention period. Batch ownership, immutable comparisons and safe same-company matching remain in force.

Admin and P0 can create ordinary controlled import batches and manage balances. A previously comparison-only batch does not become writable merely because its uploader is promoted or an administrator opens it; preserve the batch's existing immutable comparison boundary.

## Explicit subscription delegation

Subscription delegation is the one explicitly approved permission overlay, controlled on the Subscriptions page by P0. It is not an undocumented employee exception or promotion to Admin.

Two capabilities remain independent:

1. **Manage subscription register:** edit the credential-free company register, billing/membership and review records.
2. **Access subscription credentials:** use the separately encrypted service-credential catalogue and explicit reveal/save/remove workflow.

A current active linked Employee or Manager may receive either, both or neither through the audited P0 control. Granting register management must not grant password access; granting credentials must not grant register management, HR, portal accounts, payroll or leave approval. Default Managers remain register readers. Default Employees retain only their assigned minimised resources. Historical Employee grant rows remain ineffective until P0 explicitly saves the corresponding selection; the forward migration initializes neither Employee grant. Account remains excluded. Admin and P0 obtain their ordinary operational subscription rights by role; only P0 configures delegates.

The interface must state which capabilities are role-derived and which are explicit delegation. Revocation or demotion must take effect in database authorization, not wait for the browser's displayed role label to update. Existing legitimate subscription delegation and audit are retained.

## Preview, actor and state

Change profile is available only to the actual P0. It selects an employee-workspace context; it does not log in as the employee, replace the Auth session, or give the employee P0 permissions.

- The signed-in actor is authenticated and independently authorized for every operation.
- The selected target's current database role and subscription delegation determine its displayed tabs, data scope and action controls.
- Role/capability loading is independent of private contact-profile loading. An unavailable role response is an explicit retryable failure, not an Employee fallback.
- Switching or reselecting a profile refreshes its capability scope. A role save invalidates the selected view.
- Pending transitions clear privileged data. Results and mutation continuations started under target A cannot overwrite target B after switching.
- P0-only configuration controls and non-entitled vault data are never inherited by a selected employee preview.
- Any authorized mutation in preview records the real P0 actor, not the employee being displayed. Preview testing is not proof of that employee's actual JWT session.

## Database and service invariants

Legacy personal leave-review, calendar, check-in and payroll grant rows must not override the canonical role. Historical rows/events are retained rather than deleting audit to achieve a cleaner permission model. Current pending-request routing and authorization are recalculated without rewriting decided history. No role migration replays notifications, rotates a password or disables credential-delivery/reset fences.

Subscription memberships, responsible-person assignments, reporting relationships, Manager-owned notification routing, payroll reminder recipient configuration, employment classifications, accrual policies and verified machine identities remain record/eligibility/routing data, not personal administrative permissions.

Browser accounts use PostgreSQL `authenticated`; the ordinary application roles are controlled database data, not separate PostgreSQL roles or user-editable Auth metadata. RLS, explicit grants and fresh SECURITY DEFINER body checks enforce the boundary. Machine cron, recovery, analytics, notification-receipt and operator secrets remain independent protected routes; ordinary roles must not replace their authentication.

## Verification and release

Require synthetic tests of every role and actual/preview scope, including disabled/archived/unlinked/anonymous/stale-session denials, old-grant bypasses, no self-approval, pending reroutes, comparison-only commit denial, independent subscription grants, P0 equivalence, actor audit, compare-and-set role concurrency and existing credential guards. Exercise the actual asynchronous action/editor boundary, production Flight encoding and profile switching, not only source patterns or static role labels.

Release gates are `npm run check`, full disposable SQL migration replay/concurrency, browser regressions and the production bundle gate, followed by independent review. Before production apply, verify the exact MAM project and pin predecessor bodies, ACLs and reviewed migration bytes. Read back the migration ledger/functions/privileges, merged application and fixed production alias. Actual employee-role conversion is a separate authorized audited step after compatible schema/application deployment, with unique target and expected-role checks and exact readback. Never seed real employee names or identifiers into the versioned authorization schema or synthetic fixtures.
