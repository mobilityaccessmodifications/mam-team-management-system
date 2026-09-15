# People Hub UI system

## Design thesis

People Hub is an operational workspace for MAM and Equipsy staff, managers,
HR, and system administrators. The interface should make the current context,
the next action, and exceptional states obvious without making high-density
people data feel heavy.

The visual signature is a calm, Finder-like split workspace: a softly tinted
navigation sidebar, a translucent contextual toolbar, and one dark operational
summary surface on Home. Orange remains the MAM brand colour and blue remains
the Equipsy colour, but strong colour is reserved for selection, status, and
the primary action in a view.

## Information architecture

Desktop (wide):

```text
┌─ primary workspace sidebar ┬─ contextual toolbar ────────────────────────┐
│ People Hub                ├───────────────────────────────────────────────┤
│ Workspace                 │ ┌─ complete horizontal section bar →──────┐ │
│  Home                     │ │ Directory · Organisation · Check-ins ·… │ │
│  Leave                    │ └───────────────────────────────────────────┘ │
│  Calendar                 │ ┌─ toolbar / filters ──────────────────────┐ │
│  People                   │ │ grouped records │ contextual detail     │ │
│                           │ └───────────────────────────────────────────┘ │
│ profile context           │                                               │
└───────────────────────────┴───────────────────────────────────────────────┘
```

People sections always remain in one horizontally scrollable row. Selecting an
off-screen section brings it fully into view; the row never wraps into a second
line. Phone layouts retain the same section model and use a persistent,
safe-area-aware four-destination bottom navigation bar.

```text
┌─ page title ───────────────── profile/actions ─┐
│ section switcher →                             │
│                                               │
│ grouped content and task-first actions        │
│                                               │
├──── Home ──── Leave ─── Calendar ─── People ──┤
└───────────────────────────────────────────────┘
```

## Tokens

- Interface type: Geist. Barlow Condensed is limited to the People Hub wordmark.
  Geist Mono is limited to identifiers, counts, and tabular operational data.
- Canvas: `#f1f3f2`; raised surfaces: white; muted surfaces: `#f5f7f6`.
- Text: `#17211f`; secondary text: `#52605c`; tertiary labels: `#64706c`
  (4.6:1 against the canvas).
- MAM selection colour: `#ef6a24`; MAM action colour: `#c34d14` so white
  labels retain WCAG AA contrast. Equipsy action colour: `#176f98`.
- Borders are the default separation mechanism. Content surfaces use only a
  one-pixel grounding shadow; deeper shadows are reserved for floating menus,
  sheets, dialogs, and toasts.
- Core radii are 10, 12, 16, and 22 pixels. Dense controls use the smaller
  values; grouped content and temporary surfaces use the larger values.
- Translucency belongs only to functional chrome: the desktop sidebar,
  contextual toolbar, sticky section bar, and modal backdrop.

## Component rules

- A view has one visually dominant action. Secondary actions use quiet or
  outlined treatment.
- The toolbar names both the company context and current destination; the
  sidebar communicates top-level location independently of colour.
- Desktop controls may use a compact 40-pixel rhythm. Touch layouts preserve
  at least 44 by 44 pixels and account for safe areas.
- Tables remain tables on desktop and become grouped record cards only where
  existing mobile layouts already support that transformation.
- Wide registers are allowed to scroll horizontally. Column widths must fit
  complete header labels; header labels never use ellipsis.
- Tabs use tab semantics, roving focus, arrow-key navigation, and visible
  selection independent of colour. Section tabs are a single swipeable row at
  every width and automatically reveal the selected destination.
- Dialogs preserve focus trapping and focus return. Phone dialogs present as
  bottom sheets; desktop dialogs remain centred.
- Loading, empty, error, and read-only states use the same spatial hierarchy
  as loaded content so the page does not jump unexpectedly.
- The Leave primary action belongs to the shared register/approval header, so
  changing sections never moves it. Leave balances appear only inside the
  relevant request flow, not as a standing dashboard metric.

## Motion

Motion communicates state change; it is not decoration.

- Press feedback: 120 ms, `scale(.97)`.
- Selection and hover feedback: 170 ms using
  `cubic-bezier(.22, 1, .36, 1)`.
- Dialogs and sheets: 180–220 ms, transform and opacity only.
- Toasts: 180 ms vertical reveal.
- Lists, calendars, and repeated daily interactions do not animate on load.
- Keyboard tab selection does not animate. Section selection uses one subtle
  scale-and-fade of the selected surface; it never animates layout position.
  `prefers-reduced-motion` removes movement and retains only immediate state
  changes.
- `prefers-reduced-transparency` replaces blurred functional chrome with opaque
  surfaces. `prefers-contrast: more` strengthens semantic borders and text.

## Accessibility and content

- Body text and interactive labels meet WCAG AA contrast. Bright orange is
  not used behind white body text.
- Focus is always visible, with a 2-pixel ring and 3-pixel offset.
- Icon-only controls retain accessible names and tooltips where appropriate.
- Navigation labels use familiar nouns. Internal implementation terms do not
  appear in user-facing labels.
- Login is a two-part composition on larger screens (private-workspace context
  plus focused sign-in card) and collapses to one direct sign-in task on phone.
- Confidential HR and leave information is never used as a visual fixture or
  committed screenshot.
