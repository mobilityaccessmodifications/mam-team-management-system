# Mobile touch review — 8 September 2026

## Changes

- Shared modal portals escape transformed and scrolling panels. Theme variables remain available on each portal backdrop.
- Nested dialogs own focus and page scrolling as a stack. Escape closes only the top dialog; a combobox consumes Escape first.
- Small-screen/coarse-pointer dialogs focus the dialog instead of immediately opening the software keyboard.
- Modal height follows the visual viewport, including keyboard resizing; narrow and short landscape screens use a bottom sheet with safe-area padding.
- Phone form controls use 16px text and 48px input height; close/actions have at least 44px targets. Checkbox/radio labels have larger hit areas.
- Employee selection expands in the mobile form flow instead of clipping outside a scrolling modal. Keyboard selection scrolls only the option list.
- Mobile navigation/filter text and asset/subscription field captions are larger. Check-in action icons have visible mobile labels.
- Account overflow actions expand inline on mobile. Calendar detail sheets use shared focus/scroll management.
- Assets and Subscriptions expose native mobile sorting and filters even when their desktop table headers are hidden.

## Verification

- `node --test tests/dialog-focus.test.mjs`: phone focus, desktop hidden-control exclusion, Tab wrapping, nested Escape, combobox Escape and out-of-order unmount.
- Existing offline leave email/route tests ensure this UI change does not alter notification or authorization behavior.
- Lint, TypeScript and production build passed. Mobile register control callbacks were checked for sort field/direction, clearing filters and restoring default order.
- An isolated local synthetic fixture exercised the actual modal, employee-picker and asset CSS, including a transformed/overflow-hidden ancestor and nested confirmation.
- Browser geometry checked at 320×568, 390×844, 844×390 and 1280×900: no document horizontal overflow; close/actions at least 44px; dialog within viewport.
- Browser verified the 16th keyboard-selected employee remains visible, Escape closes the list before the sheet, and nested dismissal retains/restores scroll locking.
- The temporary fixture was removed before commit. No production data, credentials or email were changed.

## Verification limitations

- Ego screenshot capture timed out; DOM geometry and real browser interactions were checked, but no visual screenshot pass is claimed.
- Desktop Chromium emulation cannot certify iOS Safari keyboard, browser chrome or VoiceOver behavior. A physical-phone pass remains useful, particularly with large text and the keyboard open.
