# People Hub interface simplification — 11 September 2026

The owner requested a simpler interface across every page: direct actions, minimal repetition and only content needed to complete the task.

| Surface | Changes |
| --- | --- |
| Shell | Single page title; consistent spacing, heading scale and controls. Existing company branding and role-aware navigation remain. |
| Home | Compact task and leave lists; administrator starts with direct actions for pending reviews and People. |
| Leave register | Plain workspace tabs and status filters; shorter waiting status; concise detail rows and attachment control. |
| Approval | One contextual decision action before the calendar; calendar limited to complete weeks touched by the request. Full overlapping-event details are available on demand. |
| Request leave | Optional note/files grouped in one disclosure; part-day inputs retain their boundary explanation. |
| Calendar | Flat frame, compact event detail without a repeated privacy explanation. |
| People navigation | Plain underline tabs in place of a second framed navigation panel. |
| Directory and employee profile | Consistent readable headings, buttons and detail surfaces; aligned directory columns. Shorter employment confirmation preserves its consequences. |
| Organisation | Readable typography, quiet frame and concise reporting-line editor. |
| Check-ins and tasks | Consistent controls; due date is shown without repeating the notification date. Review reasons remain available. |
| Accounts | Consistent typography and actions; credential receipts and access-change consequences retained. |
| Assets and own devices | Removed automatic-number and history explanations; concise removal guidance. |
| Subscriptions | Optional employee access on demand; removed repeated scheduling explanation. |
| Credentials | Concise expiry and grant text; secret lifecycle and permissions preserved. |
| Analytics API | Connection instructions collapsed; key management remains immediately available. |
| Work schedule | Direct titles, single weekday labels, quieter summary. |
| Login | Single centered sign-in flow with brand, username and password. |

Verification uses synthetic approval, account, directory, Home and sign-in fixtures. Desktop and phone layouts were inspected; the production build and unit tests cover the full application.

No authorization, record visibility, payroll calculation, notification or persistence changes. Required labels, input constraints, error recovery, destructive consequences, focus handling and accessible names remain part of the interface.

## Follow-up layout corrections

Restore the pre-redesign Home content and work-schedule presentation, retaining every pending personal leave request. Leave balances and team requests are expanded by default with the complete heading. The Apply for leave action shares the status-filter row instead of reserving a row above it. Calendar uses the entire available workspace, with navigation and the top bar retaining their natural heights; DayFlow’s wrapper and calendar both fill that space.

Verified with synthetic people at 1274 × 963 and 390 × 844: the calendar meets the right and bottom viewport edges, Leave has no horizontal page overflow, and Home retains both pending personal requests.
