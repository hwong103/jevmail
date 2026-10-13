# Jevmail — design system

**Pinned reference: Gmail web (Google Material 3).** Jevmail's operate surface
is deliberately Gmail-faithful — palette, type, density, and elevation track
Gmail so the app reads as an inbox rather than a bespoke admin panel. When a
choice is open, follow Gmail.

The two product rules this system serves: **honest controls only** (nothing that
pretends to mutate mail) and **state is visible** (read/unread, uncertainty, and
"why this landed here" are always legible).

## Palette

Tokens live in `src/client/styles.css`. Light and dark are both supported via
`prefers-color-scheme`.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#f6f8fc` | `#131314` | app background |
| `--surface` | `#ffffff` | `#1f1f1f` | list/reader panels |
| `--text` | `#202124` | `#e8eaed` | primary text |
| `--muted` | `#5f6368` | `#9aa0a6` | meta, secondary text |
| `--hairline` | `#e8eaed` | `#3c4043` | 1px dividers |
| `--hover` | `#f2f6fc` | `#2a2b2e` | row/nav hover |
| `--row-read` | `#f2f6fc` | `#1b1b1c` | read-row tint |
| `--selected` | `#d3e3fd` | `#004a77` | selected row, active pill |
| `--accent` | `#1a73e8` | `#8ab4f8` | links, primary actions |
| `--nav-active-fg` | `#0b57d0` | `#a8c7fa` | text on `--selected` |
| `--search-bg` | `#eaf1fb` | `#2a2b2e` | search pill |
| `--chip-bg` | `#f1f3f4` | `#2a2b2e` | status chips, tray chip |
| `--body-block` | `#f2f6fc` | `#2a2b2e` | correction editor block |

Contrast: body and placeholder text clear 4.5:1. On `--selected`, active text
uses `--nav-active-fg`, a darker/lighter tint of the accent chosen to clear
4.5:1 where the raw accent does not. Avatar colours are a fixed saturated set,
all ≥4.5:1 against white.

Warning/banner tokens (`--warn-bg`, `--warn-border`, `--warn-text`) carry the
existing Jevmail banners (pending thread, missing body, load errors).

## Type

`--font`: `"Google Sans", Roboto, Arial, ui-sans-serif, system-ui, -apple-system,
"Segoe UI", sans-serif`.

| Role | Size | Weight |
|---|---|---|
| body | 14 | 400 |
| list row sender / subject | 14 | 400 (700 unread) |
| meta (dates, chips, why) | 12–13 | 400 |
| nav item | 14 | 400 / 600 active |
| reader subject | 22 | 500 |
| block title | 12 | 600, uppercase |

Letter-spacing never goes below `-0.01em`. Dates use tabular numerals.

## Spacing

4px base. Top bar 64px. List rows 48px min height. Reader padding 16/24px
(12/16px under 640px). Reader content measure caps at 900px.

## Radii

`--radius-card: 16px` (panels), `--radius: 12px` (blocks, banners),
`--radius-pill: 999px` (search, nav pills, chips, buttons, avatars). Selected
list rows are edge-to-edge squares, not individual pills.

## Elevation

Declared once per level: `--shadow-1` (hover lift, focused search) and
`--shadow-2` (mobile nav drawer). Shadows carry an offset and a soft blur; there
is no left-border accent stripe anywhere.

## Components

- **Top app bar**: logo mark + milled wordmark, centred search pill, status
  chips (read-only, automation off, sync), and an accent "Connect/Reconnect
  Gmail" pill.
- **Nav rail** (256px): pill nav items, one icon each, `aria-current="page"` on
  the active tray. No invented counts. A quiet footer carries "Automation off"
  and the sync state.
- **Message list**: grid of avatar / sender / subject / right-aligned date, with
  a read-only star when starred. Fills the pane while the reader is closed and
  collapses to a 400px column beside an open message. Under 900px the row stacks
  to Gmail's mobile shape: sender on line 1 (bold when unread), subject on line
  2, date at the top right.
- **Reader**: toolbar (Back, tray chip, "Correct a field", "Open in Gmail"),
  22px subject, sender row, then the message body rendered on the pane itself
  (no tinted card or border), and only then the Jev "why this landed here" and
  answers as a quieter secondary section behind a hairline. Banners and the
  correction editor are restyled, not removed.
- **Responsive**: the rail becomes an overlay drawer at ≤900px; the list is full
  width and the reader takes over when a message is open. No horizontal scroll
  at 390px.

## Motion

One authored moment: the row→reader entrance (`reader-in`, opacity + 8px
translate, `cubic-bezier(0.2, 0, 0, 1)`, 260ms) and the nav/row background
transitions. All motion collapses under `prefers-reduced-motion: reduce`.

## Icons

One authored inline-SVG set, 24px viewBox, ~2px stroke, round caps/joins,
`currentColor`. No emoji or unicode glyphs stand in for icons; the only filled
icon is the star.
