# Uplink // Secure Signal — Design System

The visual identity for the whole project is a **terminal / hacker HUD** aesthetic:
pure black canvas, phosphor-green type, monospace everywhere, sharp 0px corners,
a slow CRT scanline sweep, and glitch accents. It reads like a secure uplink
console, not a consumer video app.

> Branch: `theme/new-theme`
> This is the single source of truth for colors, type, spacing, and motion.
> All values map to CSS custom properties in `client/src/index.css`.

---

## 1. Color palette

Two tones carry the whole UI — **terminal black** and **phosphor green** — with a
red used only for errors/destructive actions. The call screen adds darker green
**outline** hairlines so the grid reads like a wiring diagram.

| Token (`--*`)          | Hex / value              | Use                                            |
| ---------------------- | ------------------------ | ---------------------------------------------- |
| `bg`                   | `#000000`                | Page / stage background (terminal black)      |
| `surface`              | `#050505`                | Cards, chat, dialog                           |
| `bg-muted`             | `#060d08`                | Inactive chips                                 |
| `surface-container`    | `#0a0a0a`                | Peer grid wrap                                 |
| `surface-container-high` | `#0f0f0f`              | Peer tile background                          |
| `surface-hover`        | `#0c1a10`                | Hover state for dark controls                  |
| `primary`              | `#00FF41`                | Terminal green — text, borders, active states  |
| `primary-hover`        | `#33ff66`                | Hover on green buttons                         |
| `primary-active`       | `#00cc33`                | Pressed green / `--secondary` hover text        |
| `primary-soft`         | `rgba(0,255,65,0.08)`    | Filled-green backgrounds (card, focus ring)    |
| `on-primary`           | `#000000`                | Text/icon on green fills                       |
| `secondary`            | `#00cc33`                | Dim green — app-bar title, chat senders        |
| `border`               | `rgba(0,255,65,0.28)`     | Default green hairlines (tiles)                |
| `border-strong`        | `rgba(0,255,65,0.6)`      | Input outlines, secondary buttons             |
| `outline`              | `#008f11`                | Darker green — call-screen panel/grid rules    |
| `outline-variant`      | `#004400`                | Even darker — app bar / footer rules           |
| `text`                 | `#00FF41`                | Primary text                                    |
| `text-secondary`       | `rgba(0,255,65,0.78)`     | Subtitles, meta                                 |
| `text-muted`           | `rgba(0,255,65,0.5)`      | Status text, captions                           |
| `danger`               | `#ff5252`                | Errors, `/exit` button, Leave/destructive     |
| `danger-hover`         | `#ff6b6b`                | Destructive hover                               |
| `on-danger`            | `#000000`                | Text on red                                     |
| `error-text`           | `#ffb4ab`                | CRT coral red for `SYS_LOGS` error lines       |
| `warning`              | `#ffb786`                | Raised-hand badge                              |
| `stage`                | `#000000`                | In-call video stage                            |

`color-scheme: dark` is set globally so scrollbars, form widgets, and the
mobile address bar adopt the dark context. The `<meta name="theme-color">` is
`#000000`. Custom green scrollbars are styled via `::-webkit-scrollbar`.

---

## 2. Typography

A single monospace family is used for **everything** — the monospace *is* the
personality.

- **Family:** `Share Tech Mono` (Google Fonts) with a monospace system fallback.
- **Preconnect:** `fonts.googleapis.com` + `fonts.gstatic.com` (in `index.html`).

Weights are 400 throughout (Share Tech Mono is a single-weight face); hierarchy
comes from size, letter-spacing, case, and color, not weight.

| Role            | Size (mobile → desktop) | Line height | Tracking        | Case     |
| --------------- | ----------------------- | ---------- | --------------- | -------- |
| Display (h1)    | 24px → 48px             | 1.3 / 1.2  | -0.01/-0.02em   | —        |
| App-bar title   | 20px                     | 1.3        | 0.05em          | glitch   |
| Headline (md)   | 20px                     | 1.3        | 0.05em          | —        |
| Body (lg)       | 18px                     | 1.5–1.6    | —               | —        |
| Body (md)       | 14–16px                  | 1.4–1.5    | —               | —        |
| Label (md)      | 12px                     | 1.3        | 0.05em          | UPPERCASE |
| Label (sm)      | 10–12px                  | 1.2        | 0.05–0.1em      | UPPERCASE |

Headings use `text-wrap: balance`; paragraphs use `text-wrap: pretty`. The display
headline gets a subtle green glow: `text-shadow: 0 0 10px rgba(0,255,65,0.35)`.
The call screen carries a faint `text-shadow: 0 0 2px rgba(0,255,65,0.4)`.

---

## 3. Spacing & shape

- **Border radius: `0px` everywhere.** Cards, buttons, inputs, tiles, badges,
  avatars, chat bubbles — all sharp. The only round shape is the loading spinner
  ring (functional, not decorative).
- **Spacing scale:** `2px (unit) · 4px · 8px · 16px · 24px · 32px`.
- **Container padding:** `16px` desktop (call screen), `40px` (landing nav/footer).
- **Max content width:** `1152px` (landing). Peer grid uses auto-fill `minmax(240px, 1fr)`.
- **Borders:** `--outline` for call-screen panels/grids; `--primary` for tiles
  and the self-view; `--outline-variant` for app-bar/footer rules.

---

## 4. Motion

| Effect        | Spec                                                                 | Notes                                        |
| ------------- | -------------------------------------------------------------------- | -------------------------------------------- |
| Scanline (landing) | 120px gradient band, `opacity .2`, `scanline 8s linear infinite` | Fixed overlay, sweeps top→bottom |
| Scanlines (call)   | static 4px stripe overlay, `mix-blend-mode: overlay`            | Fixed overlay, pointer-events none  |
| CRT flicker   | `flicker 0.15s infinite` (opacity 0.95↔1) on `.call`                  | Subtle full-screen dim; the requested effect |
| Glitch title  | `glitch-anim` / `glitch-anim-2` on `.glitch-text::before/::after`    | RGB-split slices on `UPLINK_OS_v2.4`          |
| Blink cursor  | `blink 1s step-end infinite`                                        | Trailing `_` on the landing prompt          |
| Live dot      | `live-pulse 1.4s` opacity + ring                                     | "LIVE UPLINK" chip                          |
| Button hover  | `background-color / color 0.15s ease` (fill → outline)               | Terminal buttons invert to outline on hover  |
| Spinner       | `spinner-rotate 0.6s linear infinite`                                | While creating a session                     |

**All motion is disabled under `prefers-reduced-motion`** (global guard freezes
animation/transition durations; the CRT flicker, scanline, glitch slices, and
live dot are explicitly stopped, and the glitch pseudo-elements are hidden so no
static slice is left over the title).

---

## 5. Landing page

```
┌─────────────────────────────────────────────────────────────┐
│ NAV  UPLINK                              [help] [settings]    │  green bottom border
├─────────────────────────────────────────────────────────────┤
│   UPLINK // SECURE_SIGNAL          ┌─────────────────────┐   │
│   Premium video meetings for      │ > ENTER_MEETING_CODE_│   │
│   everyone. Secure, real-time,    │  # [XXXX-XXXX-XXXX]  │   │
│   peer-to-peer video calls.       │  [ INITIATE_LINK ]   │   │
│                                   │   OR START_NEW_SESSION│  │
│                                   └─────────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│ © 2024 UPLINK SYSTEMS   LATENCY · ENCRYPTION · STATUS │
└─────────────────────────────────────────────────────────────┘
```

- `flex` column: nav + `flex:1` main + footer pinned to bottom.
- Scanline is a `position: fixed` overlay (never affects layout/scroll).
- Background: `radial-gradient(... rgba(0,255,65,0.06))` vignette.

---

## 6. Call screen

Two-column CRT HUD. **There are no media toggle buttons** — the call is driven
by a command bar.

```
┌─ UPLINK_OS_v2.4 (glitch) ─────────── ● LIVE UPLINK   [chat]* ─┐
├──────────────────────────────────────┬───────────────────────┤
│ ┌──────────────────────────────────┐ │ ┌─ COMMS_LINK ────────┐│
│ │ peer  │ peer  │ peer   │ peer   │ │ │ [time] [NAME]: text ││
│ │ peer  │ peer  │        │        │ │ │ ...chat messages... ││
│ │                  ┌─HOST_PRIME──┐│ │ └─────────────────────┘│
│ │                  │ self-view PiP││ │ ┌─ SYS_LOGS ───────────┐│
│ │                  └─────────────┘│ │ │ > ENCRYPTION: ACTIVE ││
│ └──────────────────────────────────┘ │ │ > HANDSHAKE: SUCCESS││
│ > [enter command]   /mute /cam /exit  │ │ > live event log…   ││
├──────────────────────────────────────┴─┴──────────────────────┘│
│ © 2142 UPLINK_CORE      LATENCY · NODES: n · ENCRYPTION│
└──────────────────────────────────────────────────────────────┘
(* chat icon only on mobile)
```

- **Left column (`flex:1`):** peer grid (scrollable, auto-fill tiles) + a floating
  `HOST_PRIME` self-view PiP pinned bottom-right + the command bar + HUD footer.
- **Right column (desktop only, `320px`):** `COMMS_LINK` chat (flex 2) +
  `SYS_LOGS` (flex 1).
- **Mobile (<768px):** the right column is hidden; chat becomes a side **dock**
  opened by a chat icon in the app bar and closed via its own close button.
  `SYS_LOGS` is desktop-only (no room on mobile).
- **Self-view is always the floating PiP** (replaces the old single/spotlight/grid
  modes; layout is now pure CSS — no JS measurement).

### Commands (the control model)

The command bar accepts slash commands (Enter to run); the three shortcut buttons
just fire the matching command. Commands are case-insensitive.

| Command (aliases) | Action |
| ------------------ | ------ |
| `/mute` `/unmute` `/mic` | toggle microphone (`toggleMic`) |
| `/cam` `/camera` `/video` | toggle camera (`toggleCamera`) |
| `/share` `/screen` `/present` | toggle screen share (`toggleScreenShare`) |
| `/hand` `/raise` | raise hand (socket `raise-hand`; echoes back, auto-lowers in 6s) |
| `/chat` `/comms` | toggle the chat dock (mobile) |
| `/copy` `/invite` `/link` | copy invite link |
| `/exit` `/leave` `/quit` | open the leave confirm dialog |
| `/help` `/?` `/commands` | list commands in `SYS_LOGS` |
| unknown | `> ERR: unknown command` in `SYS_LOGS` |

### SYS_LOGS

Wired to real events instead of a random timer: initial `ENCRYPTION: ACTIVE` /
`HANDSHAKE: SUCCESS` / `AWAITING INPUT…`, then `UPLINK ESTABLISHED`, `SYNC
COMPLETE`, `NEW_NODE uplink`, `NODE dropped`, each command run, and uplink
errors. Capped to the last 80 lines, auto-scrolled.

---

### Latency readout

The `LATENCY` readout is a real measured value, not static flavor. The landing
page measures round-trip time to the signaling server via a `latency:probe`
socket echo (every 5s; `--` when unreachable). The call screen measures
worst-case peer-to-peer RTT via WebRTC `getStats()` (selected ICE candidate-
pair `currentRoundTripTime`, every 5s; `--` until a peer connects).

## 7. Component → behaviour mapping

### Landing
| UI element | Class(es) | Behaviour |
| --- | --- | --- |
| Meeting-code input | `terminal-input home__input` | `joinRoom()` → `navigate(/room/:id)` |
| `INITIATE_LINK` | `terminal-button home__submit` (submit) | form → `joinRoom()` |
| `OR START_NEW_SESSION` | `home__alt-link` (button) | `createRoom()` → socket `create-room` |
| Help / Settings | `home__icon-btn` | HUD affordances (icon-only, `aria-label`) |
| Error | `form-error` (`role="alert"`) | focused on submit |

### Call
| UI element | Class(es) | Behaviour |
| --- | --- | --- |
| Command input | `cmdbar__input` | `runCommand()` parser |
| Quick buttons | `cmdbar__btn` / `cmdbar__btn--danger` | run `/mute` `/cam` `/exit` |
| Chat dock toggle (mobile) | `call__chat-toggle` | `setChatOpen` |
| Peer tiles | `tile` + `tile__name` / `tile__icons` / badges | remote peers; host shown with ★ |
| Self-view PiP | `call__self` + `tile` (`isSelfView`) | local stream, HOST/OPERATOR bar |
| Chat | `chat` (`COMMS_LINK`) | socket `chat-message`; timestamps via `Intl.DateTimeFormat` |
| Sys logs | `syslogs` (`SYS_LOGS`) | live event log |
| Leave | `ConfirmDialog` | `/exit` → confirm → `leaveRoom()` |

---

## 8. Implementation notes

- **Single CSS file:** `client/src/index.css` holds all tokens and styles;
  components read `var(--*)` so re-theming is editing one `:root` block.
- **Sharp corners** via `--radius-*: 0` plus explicit `border-radius: 0` on the
  elements that previously used `50%` (control buttons are gone; avatars/badges/
  tiles/chat are sharp). The spinner ring stays round.
- **Video-tile name labels** are a green-on-black tag at top-left (readable over
  video). Off-indicators (mic/cam) are red, bottom-left.
- **No JS layout** for the call — the peer grid is a CSS auto-fill grid and the
  self-view is an absolute PiP. `computeTileLayout`/stage measurement were removed.
- **Fonts** load from Google Fonts with `display=swap` + preconnect; the system
  monospace stack is the fallback.
- **`design.md`** (this file) is the canonical reference — keep it in sync.