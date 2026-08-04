# Leave management business rules

## Confirmed

- Managers and team leads need a shared view of who is away so coverage does not depend on asking around in person.
- The initial release is for management review before any all-staff rollout.
- Nixon owns the delivery priority; a team-supplied priority is input, not a command.
- Employee and HR data is confidential.
- A final human decision remains required; the system does not auto-approve leave in Phase 1.

## Decisions required before live use

1. Who may submit leave: employee, manager on behalf of an employee, or both?
2. Who approves each team, and who acts when the manager is away?
3. What overlap information can employees see: names and dates, team totals only, or nothing?
4. Which leave categories are supported and which reasons are private to HR?
5. Can an employee edit or cancel after submission or approval?
6. Are weekends, public holidays and part-time work patterns calculated automatically?
7. Which systems receive the approved result: Outlook, payroll, AroFlo, Teams, or none initially?
8. What is the retention period for rejected/cancelled requests and event history?
9. What counts as manager-ready versus all-staff-ready?
10. Which exact email domain(s) may sign in?

## Demo behaviour — not final payroll policy

- The synthetic demo offers Annual leave, Sick leave, Carer's leave and Unpaid leave.
- A part-day request can optionally specify a start and end time between 6:00 am and 6:00 pm in fixed 15-minute intervals when both dates are the same; leaving both times blank means full working days.
- The demo derives elapsed hours from the selected times. Break deductions, standard daily hours, payroll treatment and evidence requirements still need confirmation before live use.
- Manager review shows a calendar from three weeks before the requested start through three weeks after the requested end, rounded to full Monday-to-Sunday weeks. The applicant is highlighted, relevant team leave and public holidays are visible, and another employee's private reason is never shown.

## Data minimisation

- The team calendar should show only what is required for coverage.
- Detailed reasons and attachments must not appear in the shared calendar.
- Use synthetic names and dates in development, CI, screenshots and demos.
