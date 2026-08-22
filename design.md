# Nexus // Secure_Uplink — Design System

The visual identity for the whole project is a **terminal / hacker HUD** aesthetic:
pure black canvas, phosphor-green type, monospace everywhere, sharp 0px corners,
and a slow CRT scanline sweep. It reads like a secure uplink console, not a
consumer video app.

> Branch: `theme/new-theme`
> This is the single source of truth for colors, type, spacing, and motion.
> All values map to CSS custom properties in `client/src/index.css`.

---

## 1. Color palette

Two tones carry the whole UI — **terminal black** and **phosphor green** — with a
red used only for errors/destructive actions. Surfaces are near-black with a
faint green tint; borders are translucent green so the grid feels like a wiring
diagram.

| Token (`--*`)         | Hex / value              | Use                                            |
| -------------------- | ------------------------ | ---------------------------------------------- |
| `bg`                 | `#000000`                | Page / stage background (terminal black)        |
| `surface`            | `#040a06`                | Cards, name gate, dialog                       |
| `bg-muted`           | `#060d08`                | Inactive control chips, chat bubbles           |
| `surface-hover`      | `#0c1a10`                | Hover state for dark controls                  |
| `primary`            | `#00FF41`                | Terminal green — text, borders, active states  |
| `primary-hover`      | `#33ff66`                | Hover on green buttons                         |
| `primary-active`     | `#00cc34`                | Pressed green                                  |
| `primary-soft`       | `rgba(0,255,65,0.08)`    | Filled-green backgrounds (entry card, focus ring) |
| `on-primary`         | `#000000`                | Text/icon on green fills                       |
| `border`             | `rgba(0,255,65,0.28)`     | Default green hairlines                         |
| `border-strong`      | `rgba(0,255,65,0.6)`      | Input outlines, secondary button borders       |
| `text`               | `#00FF41`                | Primary text                                    |
| `text-secondary`     | `rgba(0,255,65,0.78)`     | Subtitles, meta                                 |
| `text-muted`         | `rgba(0,255,65,0.5)`      | Status text, captions                           |
| `danger`             | `#ff5252`                | Errors, Leave/destructive                      |
| `danger-hover`       | `#ff6b6b`                | Destructive hover                               |
| `on-danger`          | `#000000`                | Text on red                                     |
| `warning`            | `#ffb786`                | Raised-hand badge                              |
| `stage`              | `#000000`                | In-call video stage                            |

`color-scheme: dark` is set globally so scrollbars, form widgets, and the
mobile address bar adopt the dark context. The `<meta name="theme-color">` is
`#000000`.

---

## 2. Typography

A single monospace family is used for **everything** (display, headings, body,
labels, data). No sans-serif, no second face — the monospace *is* the personality.

- **Family:** `JetBrains Mono` (Google Fonts, weights 400 / 500 / 700), with a
  monospace system fallback stack.
- **Preconnect:** `fonts.googleapis.com` + `fonts.gstatic.com` (in `index.html`).

| Role          | Size (mobile → desktop) | Line height | Weight | Tracking        |
| ------------- | ----------------------- | ---------- | ------ | --------------- |
| Display (h1)  | 24px → 48px             | 1.3 / 1.2  | 700    | -0.01em/-0.02em |
| Headline (md) | 24px                     | 1.4        | 700    | —               |
| Body (lg)     | 18px                     | 1.6        | 400    | —               |
| Body (md)     | 16px                     | 1.6        | 400    | —               |
| Label (md)    | 14px                     | 1.4        | 500    | 0.02em          |
| Label (sm)    | 12px                     | 1.2        | 700    | 0.05em, UPPERCASE |
| Footer stats  | 12px                     | 1.2        | 700    | 0.05em, UPPERCASE |

Headings use `text-wrap: balance`; body paragraphs use `text-wrap: pretty`.
The display headline gets a subtle green glow: `text-shadow: 0 0 10px rgba(0,255,65,0.35)`.

---

## 3. Spacing & shape

- **Border radius: `0px` everywhere.** No rounding on cards, buttons, inputs,
  tiles, badges, avatars, or chat bubbles. The only round shape in the UI is the
  loading spinner ring (functional, not decorative).
- **Spacing scale:** `4px (unit) · 8px (stack-sm) · 16px (stack-md) · 24px (gutter) · 32px (stack-lg)`.
- **Container padding:** `16px` mobile, `40px` desktop (nav + footer).
- **Max content width:** `1152px` (6xl). Entry card `448px`, hero `576px`.
- **Borders:** 1px green hairlines (`--border`) for most surfaces; `--border-strong`
  for inputs and outline buttons.

---

## 4. Motion

| Effect        | Spec                                                                 | Notes                                        |
| ------------- | -------------------------------------------------------------------- | -------------------------------------------- |
| Scanline      | 120px gradient band, `opacity .2`, `scanline 8s linear infinite`     | Fixed overlay, `pointer-events:none`, sweeps top→bottom |
| Blink cursor  | `blink 1s step-end infinite` (opacity 1↔0)                          | Trailing `_` on the `> ENTER_MEETING_CODE` prompt |
| Button hover  | `background-color / color 0.15s ease` (fill → outline)               | Terminal buttons invert to outline on hover  |
| Spinner       | `spinner-rotate 0.6s linear infinite`                                | Shown while creating a session               |

All animation is **disabled under `prefers-reduced-motion`** (global guard sets
animation/transition durations to ~0 and `scroll-behavior: auto`). The scanline
freezes and the cursor stops blinking — no motion for users who opt out.

---

## 5. Layout (landing page)

```
┌─────────────────────────────────────────────────────────────┐
│ NAV  NEXUS                              [help] [settings]   │  ← 64px, green bottom border
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   NEXUS // SECURE_UPLINK          ┌─────────────────────┐   │
│   Premium video meetings for      │ > ENTER_MEETING_CODE_│   │
│   everyone. Secure, real-time,    │  # [XXXX-XXXX-XXXX]  │   │
│   peer-to-peer video calls.       │  [ INITIATE_LINK ]   │   │
│                                   │   OR START_NEW_SESSION│  │
│                                   └─────────────────────┘   │
│          (hero left · entry card right, stacks on mobile)   │
├─────────────────────────────────────────────────────────────┤
│ © 2024 NEXUS SYSTEMS INTERFACE   LATENCY · ENCRYPTION · STATUS │ ← green top border, blur
└─────────────────────────────────────────────────────────────┘
```

- `flex-direction: column`, nav + `flex: 1` main + footer pinned to the bottom.
- Scanline is a `position: fixed` overlay so it never affects layout or scroll.
- Background: `radial-gradient(... rgba(0,255,65,0.06))` vignette for a faint CRT glow.

---

## 6. Component → element mapping (backend wiring)

| UI element                      | Class(es)                              | Behaviour                                                       |
| ------------------------------- | -------------------------------------- | --------------------------------------------------------------- |
| Meeting-code input              | `terminal-input home__input`           | Validated on submit via `joinRoom()` → `navigate(/room/:id)`     |
| `INITIATE_LINK` button          | `terminal-button home__submit` (submit)| Triggers the form → `joinRoom()`                                |
| `OR START_NEW_SESSION` link     | `home__alt-link` (button)              | `createRoom()` → socket `create-room` → `navigate(/room/:id)`   |
| Help / Settings nav buttons     | `home__icon-btn`                       | HUD affordances (icon-only, `aria-label` + `title`)             |
| Footer stats                    | `home__footer-stats`                   | Decorative HUD (`aria-hidden="true"`)                           |
| Error message                   | `form-error` (`role="alert"`)          | Focused on submit for a11y (`ref` + `tabIndex=-1`)             |
| Loading                         | `.spinner`                             | Spins while `creating`; freezes under reduced-motion            |

---

## 7. Implementation notes

- **Single CSS file:** `client/src/index.css` holds all tokens and component
  styles. Components consume tokens via `var(--*)` so re-theming the project is
  editing one `:root` block.
- **Sharp corners** are enforced both via the `--radius-*` tokens (`0px`) and by
  setting `border-radius: 0` directly on the few elements that previously used
  `50%` (control buttons, chat close, avatars, badges, tiles).
- **Video-tile name labels stay white-on-black** (`rgba(0,0,0,.65)` / `#fff`)
  because they overlay real video — readability wins over theme fidelity there.
- **Fonts** load from Google Fonts with `display=swap` + preconnect; the system
  monospace stack is the fallback so the UI renders correctly before the font
  arrives.
- **`design.md`** (this file) is the canonical reference — keep it in sync when
  tokens change.