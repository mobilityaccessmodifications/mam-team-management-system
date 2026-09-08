# Mobile profile and width regression — 8 September 2026

Scope: own-profile overlay, compact account trigger, shared mobile page rail,
and leave request form. No permissions, persistence or email changes.

| Before | After | Why |
| --- | --- | --- |
| Profile panel inside the filtered top bar | Portal outside the top bar, bounded by the visual viewport | Fixed positioning must not be trapped by the header |
| Nested avatar borders and chevron bubble | One 44px initials button | Clear, finger-sized account control |
| Different page gutters and calendar negative margin | Shared 16px page gutters | Consistent content alignment |
| 20px negative footer margins with 16px form padding | Matching footer margins and padding | Removes horizontal form overflow |
| Scale/translate on sheet entry | Stable mobile form bounds; immediate profile open/close | Avoids temporary clipping and stale exit layers |

## Verification

Ego browser with touch emulation and a temporary, removed local fixture using
the actual SelfProfileMenu, ModalBackdrop, dialog hook and leave form CSS.
All fixture values were synthetic; no production requests were submitted.

- Profile visible/hit-testable and horizontally contained at 320×740, 390×844,
  430×932, 844×390 and desktop 1280×900.
- At 390×844 the profile sheet spans x=0..390 and y=135..844.
- Profile phone input can be edited without closing the portal; content scrolls.
- Close button, Escape and backdrop dismissal remove the dialog and release
  the page scroll lock. Use `Escape`, not `ESC`, in the browser helper.
- Apply form has zero horizontal overflow at 320×740, 390×844 and 844×390;
  date fields use shrinkable tracks and stack below 380px.
- At 320px the Apply button is x=16, width=288, height=48; at 390px it is
  x=16, width=358, height=48.
- Desktop profile remains anchored below the account control.

Real iPhone Safari/keyboard behaviour still requires device confirmation;
Chromium emulation is not physical-device verification.
