# People Hub UI system

## Design thesis

People Hub is an operational workspace for MAM and Equipsy staff, managers,
HR, and system administrators. The interface should make the current context,
the next action, and exceptional states obvious without making high-density
people data feel heavy.

The visual signature is a persistent dark operations rail with a thin company
colour activity marker. Orange remains the MAM brand colour and blue remains
the Equipsy colour, but strong colour is reserved for selection, status, and
the primary action in a view.

## Information architecture

Desktop (wide):

```text
┌─ primary operations rail ─┬─ page toolbar ───────────────────────────────┐
│ People Hub                ├───────────────────────────────────────────────┤
│                           │ ┌─ People section rail ─┬─ active workspace ┐ │
│ Home                      │ │ Directory             │ filters / action │ │
│ Leave                     │ │ Organisation          │ grouped records  │ │
│ Calendar                  │ │ Check-ins             │ detail panel     │ │
│ People                    │ │ …                     │                  │ │
│                           │ └───────────────────────┴──────────────────┘ │
│ profile context           │                                               │
└───────────────────────────┴───────────────────────────────────────────────┘
```

Compact desktop and tablet use a complete, adaptively wrapped People section
switcher so every destination remains visible. Phone layouts use a horizontally
scrollable section switcher and a persistent four-destination bottom navigation
rail.

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
- Canvas: `#f4f6f5`; raised surfaces: white; muted surfaces: `#eef2f0`.
- Text: `#182421`; secondary text: `#4b5b56`.
- MAM selection colour: `#ef6a24`; MAM action colour: `#c34d14` so white
  labels retain WCAG AA contrast. Equipsy action colour: `#176f98`.
- Borders are the default separation mechanism. Shadows are reserved for
  floating menus, sheets, dialogs, and toasts.
- Core radii are 8, 10, 14, and 18 pixels. Dense registers use the smaller
  values; floating surfaces use the larger values.

## Component rules

- A view has one visually dominant action. Secondary actions use quiet or
  outlined treatment.
- Desktop controls may use a compact 40-pixel rhythm. Touch layouts preserve
  at least 44 by 44 pixels and account for safe areas.
- Tables remain tables on desktop and become grouped record cards only where
  existing mobile layouts already support that transformation.
- Tabs use tab semantics, roving focus, arrow-key navigation, and visible
  selection independent of colour.
- Dialogs preserve focus trapping and focus return. Phone dialogs present as
  bottom sheets; desktop dialogs remain centred.
- Loading, empty, error, and read-only states use the same spatial hierarchy
  as loaded content so the page does not jump unexpectedly.

## Motion

Motion communicates state change; it is not decoration.

- Press feedback: 100–140 ms, `scale(.97)`.
- Selection and hover feedback: 140–180 ms using
  `cubic-bezier(.23, 1, .32, 1)`.
- Dialogs and sheets: 180–220 ms, transform and opacity only.
- Toasts: 180 ms vertical reveal.
- Lists, calendars, and repeated daily interactions do not animate on load.
- Keyboard tab selection does not animate. `prefers-reduced-motion` removes
  movement and retains only immediate state changes.

## Accessibility and content

- Body text and interactive labels meet WCAG AA contrast. Bright orange is
  not used behind white body text.
- Focus is always visible, with a 2-pixel ring and 3-pixel offset.
- Icon-only controls retain accessible names and tooltips where appropriate.
- Navigation labels use familiar nouns. Internal implementation terms do not
  appear in user-facing labels.
- Confidential HR and leave information is never used as a visual fixture or
  committed screenshot.
