//! Bottom-deck TUI: chat panel, status border, key-prefixed buttons.
//!
//! Collapsed (3 rows):
//!   ┌ video (cols × rows-3) ┐
//!   ─ ⏺ LIVE · ▲ 24fps 960×540 · ↕ 42ms · ⏱ 03:12 · 🎟 code · 👥 names ──
//!     💬 BrowserG: hey!                    (latest event, dim)
//!     [c] CAM ON  [m] MIC ON  [t] CHAT  [y] COPY CODE  [q] LEAVE
//!
//! Chat open (`t`, Esc closes — deck grows to 10 rows, video reflows):
//!     ... 6 chat log rows + `❯ input` line above the same border/buttons.
//!
//! Buttons carry their own keyboard shortcut, so the deck teaches itself.
//! One stdin thread parses BOTH the kitty ACK stream (flow control) and
//! user input (SGR mouse clicks + plain keys); the render loop only polls
//! counters and an action queue.

use std::collections::VecDeque;
use std::io::Stdout;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Mutex, Once};

use ratatui::backend::CrosstermBackend;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::{Terminal, TerminalOptions, Viewport};

#[derive(Clone, PartialEq, Debug)]
pub enum Action {
    ToggleCamera,
    ToggleMic,
    CopyCode,
    Leave,
    OpenChat,
    CloseChat,
    SendChat(String),
}

pub fn camera_on() -> bool {
    CAMERA_ON.load(Ordering::SeqCst)
}
pub fn set_camera_on(on: bool) {
    CAMERA_ON.store(on, Ordering::SeqCst);
    with_ui(|ui| ui.cam_on = on);
}
static CAMERA_ON: AtomicBool = AtomicBool::new(true);

struct Ui {
    room_code: String,
    media: String,
    participants: Vec<String>,
    events: VecDeque<String>,
    fps: u32,
    enc: (u32, u32),
    cam_on: bool,
}

impl Default for Ui {
    fn default() -> Self {
        Self {
            room_code: String::new(),
            media: String::from("starting…"),
            participants: Vec::new(),
            events: VecDeque::new(),
            fps: 0,
            enc: (0, 0),
            cam_on: true,
        }
    }
}

static UI: Mutex<Option<Ui>> = Mutex::new(None);
static ACKED: AtomicU64 = AtomicU64::new(0);
static ACTIONS: Mutex<VecDeque<Action>> = Mutex::new(VecDeque::new());
static MY_NAME: Mutex<String> = Mutex::new(String::new());
static TYPING: AtomicBool = AtomicBool::new(false);
static INPUT: Mutex<Vec<u8>> = Mutex::new(Vec::new());
static RTT_MS: AtomicU32 = AtomicU32::new(0);
static CALL_SECS: AtomicU64 = AtomicU64::new(0);

/// One chat message (mine or a peer's).
#[derive(Clone, Debug)]
pub struct ChatMsg {
    pub name: String,
    pub text: String,
    pub mine: bool,
}
static CHAT: Mutex<VecDeque<ChatMsg>> = Mutex::new(VecDeque::new());

/// Chat rows when the panel is open in BOTTOM mode (narrow terminals).
pub const CHAT_ROWS: usize = 6;

/// Sidebar width (incl. its left border) when chat opens on wide terminals.
pub const SIDEBAR_W: u16 = 34;

/// Bottom-panel chat mode kicks in on narrow terminals.
pub fn sidebar_mode(cols: u16) -> bool {
    TYPING.load(Ordering::SeqCst) && cols >= 100
}

/// Total chrome rows around the video (header + bottom border + buttons).
pub fn deck_rows() -> u16 {
    3 // header + bottom border + buttons; the chat sidebar steals columns
}

/// Video area width in cells for the given terminal width.
pub fn video_cols(cols: u16) -> u16 {
    let inset = 2u16; // frame verticals
    let side = if sidebar_mode(cols) { SIDEBAR_W } else { 0 };
    cols.saturating_sub(inset + side).max(20)
}

/// Video tile grid (cols, rows) painted by the compositor.
static TILE_GRID: Mutex<(u16, u16)> = Mutex::new((1, 1));
/// One name per tile cell, in cell order (local first).
static TILE_NAMES: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub fn set_tile_grid(cols: u16, rows: u16) {
    *TILE_GRID.lock().unwrap_or_else(|e| e.into_inner()) = (cols, rows);
}

pub fn set_tile_names(names: Vec<String>) {
    *TILE_NAMES.lock().unwrap_or_else(|e| e.into_inner()) = names;
}

/// Letterboxed grid cell rects in SCREEN CELLS (origin x/y, cell w/h), as
/// computed by the compositor. paint_deck just reads them for labels.
static TILE_METRICS: Mutex<(u16, u16, u16, u16)> = Mutex::new((2, 1, 0, 0));

pub fn set_tile_metrics(ox: u16, oy: u16, cw: u16, ch: u16) {
    *TILE_METRICS.lock().unwrap_or_else(|e| e.into_inner()) = (ox, oy, cw, ch);
}

/// My display name for the local tile label (fallback "you").
pub fn local_label() -> String {
    let me = my_name();
    if me.is_empty() { "you".to_string() } else { me }
}

pub fn set_my_name(name: &str) {
    *MY_NAME.lock().unwrap_or_else(|e| e.into_inner()) = name.to_string();
}

pub fn my_name() -> String {
    MY_NAME.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

pub fn set_rtt(ms: u32) {
    RTT_MS.store(ms, Ordering::SeqCst);
}

pub fn set_call_secs(secs: u64) {
    CALL_SECS.store(secs, Ordering::SeqCst);
}

pub fn set_typing(on: bool) {
    TYPING.store(on, Ordering::SeqCst);
    if !on {
        INPUT.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}

pub fn typing() -> bool {
    TYPING.load(Ordering::SeqCst)
}

/// Store an incoming/outgoing chat message; cap the log.
pub fn push_chat(name: &str, text: &str, mine: bool) {
    let mut chat = CHAT.lock().unwrap_or_else(|e| e.into_inner());
    chat.push_back(ChatMsg {
        name: name.to_string(),
        text: text.to_string(),
        mine,
    });
    while chat.len() > 100 {
        chat.pop_front();
    }
}

fn chat_input_push(byte: u8) {
    let mut inp = INPUT.lock().unwrap_or_else(|e| e.into_inner());
    if inp.len() < 480 {
        inp.push(byte);
    }
}

/// Backspace one grapheme-ish unit: pop continuation bytes, then one lead byte.
fn chat_input_backspace() {
    let mut inp = INPUT.lock().unwrap_or_else(|e| e.into_inner());
    while inp.pop().is_some_and(|b| b & 0xC0 == 0x80) {}
}

fn chat_input_take() -> String {
    let mut inp = INPUT.lock().unwrap_or_else(|e| e.into_inner());
    String::from_utf8_lossy(&std::mem::take(&mut *inp)).into_owned()
}
static KITTY_ERRORS: Mutex<Vec<String>> = Mutex::new(Vec::new());
static INPUT_STARTED: Once = Once::new();

type Term = Terminal<CrosstermBackend<Stdout>>;
static TERMINAL: Mutex<Option<Term>> = Mutex::new(None);
/// Clickable button rects in ABSOLUTE screen coords.
static BUTTONS: Mutex<Vec<(Rect, Action)>> = Mutex::new(Vec::new());
static LAST_AREA: Mutex<Option<Rect>> = Mutex::new(None);

pub fn acked() -> u64 {
    ACKED.load(Ordering::SeqCst)
}

pub fn take_kitty_errors() -> Vec<String> {
    std::mem::take(&mut KITTY_ERRORS.lock().unwrap_or_else(|e| e.into_inner()))
}

/// Pop one queued user action (mouse click / key), if any.
pub fn poll_action() -> Option<Action> {
    ACTIONS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .pop_front()
}

/// One decoded key from the input thread: builds the chat message while
/// typing, otherwise drives the shortcuts.
pub fn handle_key(b: u8) {
    if TYPING.load(Ordering::SeqCst) {
        match b {
            0x0d | 0x0a => {
                let text = chat_input_take();
                if !text.is_empty() {
                    push_action(Action::SendChat(text));
                }
            }
            0x1b => set_typing(false),
            0x03 => push_action(Action::Leave), // Ctrl+C always quits
            0x7f => chat_input_backspace(),
            0x20..=0x7e | 0x80..=0xff => chat_input_push(b),
            _ => {}
        }
    } else {
        match b {
            b't' | b'i' => set_typing(!TYPING.load(Ordering::SeqCst)),
            b'q' | b'l' | 0x03 => push_action(Action::Leave),
            b'c' => push_action(Action::ToggleCamera),
            b'm' => push_action(Action::ToggleMic),
            b'y' => push_action(Action::CopyCode),
            _ => {}
        }
    }
}

pub fn push_action(a: Action) {
    ACTIONS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push_back(a);
}

pub fn set_room_code(code: &str) {
    with_ui(|ui| ui.room_code = code.to_string());
}

/// Current room code (for the copy-to-clipboard action).
pub fn room_code() -> String {
    with_ui(|ui| ui.room_code.clone())
}

pub fn set_participants(names: Vec<String>) {
    with_ui(|ui| ui.participants = names);
}

/// Roster as (socket_id, display_name) — resolves tile labels.
static ROSTER: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

pub fn set_roster(entries: Vec<(String, String)>) {
    *ROSTER.lock().unwrap_or_else(|e| e.into_inner()) = entries;
}

pub fn name_for_socket(id: &str) -> Option<String> {
    ROSTER
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .find(|(sid, _)| sid == id)
        .map(|(_, n)| n.clone())
}

pub fn set_media(msg: &str) {
    with_ui(|ui| ui.media = msg.to_string());
}

pub fn push_event(msg: &str) {
    with_ui(|ui| {
        ui.events.push_back(msg.to_string());
        while ui.events.len() > 1 {
            ui.events.pop_front();
        }
    });
}

pub fn set_stats(fps: u32, w: u32, h: u32) {
    with_ui(|ui| {
        ui.fps = fps;
        ui.enc = (w, h);
    });
}

fn ui() -> std::sync::MutexGuard<'static, Option<Ui>> {
    UI.lock().unwrap_or_else(|e| e.into_inner())
}

/// Ensure the singleton exists and return the inner guard.
fn with_ui<T>(f: impl FnOnce(&mut Ui) -> T) -> T {
    let mut guard = UI.lock().unwrap_or_else(|e| e.into_inner());
    let ui = guard.get_or_insert_with(Ui::default);
    f(ui)
}

/// Split `s` into (line1, Some(line2)) at `max` display chars, word-aware.
fn wrap_at(s: &str, max: usize) -> (String, Option<String>) {
    if s.chars().count() <= max {
        return (s.to_string(), None);
    }
    let cut = s
        .char_indices()
        .take(max + 1)
        .filter(|(i, c)| *i <= max && (*c == ' ' || *i == max))
        .map(|(i, _)| i)
        .fold(0usize, std::cmp::max);
    let (a, b) = s.split_at(cut);
    (a.trim_end().to_string(), Some(b.trim_start().to_string()))
}

fn truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max_chars.saturating_sub(1)).collect();
        format!("{cut}…")
    }
}

// ── Deck painting (ratatui, fixed bottom viewport) ──────────────────────

/// Paint the 4-row deck. ratatui diffs the buffer — only changed cells are
/// written, so per-frame repaints never flicker.
pub fn paint_deck() {
    let (cols, rows) = crossterm::terminal::size()
        .map(|(c, r)| (c as u16, r as u16))
        .unwrap_or((100, 30));
    if cols < 40 || rows < 8 {
        return;
    }
    let area = Rect { x: 0, y: 0, width: cols, height: rows };

    // Fresh terminal each paint → the whole chrome re-asserts over the video.
    let mut guard = TERMINAL.lock().unwrap_or_else(|e| e.into_inner());
    {
        let term = Terminal::with_options(
            CrosstermBackend::new(std::io::stdout()),
            TerminalOptions {
                viewport: Viewport::Fixed(area),
            },
        )
        .expect("ratatui terminal");
        *guard = Some(term);
        *LAST_AREA.lock().unwrap_or_else(|e| e.into_inner()) = Some(area);
    }
    let term = guard.as_mut().unwrap();

    // ── snapshot ──
    let (room_code, media, people, tick1, fps, enc, cam_on, mic_on, chat_open, chat_log, input_txt, rtt, call_secs) = {
        let mut ui = ui();
        let Some(ui) = ui.as_mut() else { return };
        let people = if ui.participants.is_empty() {
            "you".to_string()
        } else {
            ui.participants.join(", ")
        };
        let t1 = ui.events.iter().next_back().cloned().unwrap_or_default();
        let chat_log: Vec<ChatMsg> = if TYPING.load(Ordering::SeqCst) {
            CHAT
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .iter()
                .rev()
                .take(CHAT_ROWS.max(60))
                .rev()
                .cloned()
                .collect()
        } else {
            Vec::new()
        };
        let input_txt = {
            let inp = INPUT.lock().unwrap_or_else(|e| e.into_inner());
            String::from_utf8_lossy(&inp).into_owned()
        };
        (
            ui.room_code.clone(),
            ui.media.clone(),
            people,
            t1,
            ui.fps,
            ui.enc,
            ui.cam_on,
            crate::audio::mic_on(),
            TYPING.load(Ordering::SeqCst),
            chat_log,
            input_txt,
            RTT_MS.load(Ordering::SeqCst),
            CALL_SECS.load(Ordering::SeqCst),
        )
    };

    use ratatui::style::Color;
    use ratatui::widgets::{Block, BorderType, Borders, Clear, List, ListItem, ListState};

    // ── palette (Lip Gloss-style: one accent + status colors + muted grays) ──
    let accent = Color::Rgb(125, 86, 244); // lipgloss purple
    let ok = Color::Rgb(152, 195, 121);
    let err = Color::Rgb(224, 108, 117);
    let warn = Color::Rgb(229, 192, 123);
    let text_c = Color::Rgb(220, 223, 228);
    let muted = Color::Rgb(99, 106, 118);
    let border = Color::Rgb(63, 68, 81);
    let panel_bg = Color::Rgb(15, 16, 20);

    let (dot, state) = if media.contains('⚠') {
        (err, "live · issue")
    } else if media.contains('🔗') || media.contains('🎥') || media.contains('🔊') {
        (ok, "live")
    } else {
        (warn, "waiting")
    };

    let secs_lbl = format!("{:02}:{:02}", call_secs / 60, call_secs % 60);
    let sidebar = sidebar_mode(cols);
    let sb_x = cols.saturating_sub(SIDEBAR_W);
    let bold = Modifier::BOLD;

    // ── header: lives in the TOP BORDER as block titles ─────────────────
    let mut h_left = vec![
        Span::styled(" uplink ", Style::default().fg(accent).add_modifier(bold)),
        Span::styled("│ ", Style::default().fg(border)),
        Span::styled("● ", Style::default().fg(dot)),
        Span::styled(state, Style::default().fg(dot).add_modifier(bold)),
        Span::styled(format!(" · {} ", secs_lbl), Style::default().fg(text_c)),
        Span::styled("│ ", Style::default().fg(border)),
        Span::styled(
            format!("room {} ", truncate(&room_code, 14)),
            Style::default().fg(accent),
        ),
        Span::styled("│ ", Style::default().fg(border)),
        Span::styled(truncate(&people, 40), Style::default().fg(text_c)),
    ];
    let h_right = if !tick1.is_empty() {
        let ev_txt: String = tick1.chars().filter(|c| c.is_ascii()).collect();
        Line::from(vec![
            Span::styled("> ", Style::default().fg(muted)),
            Span::styled(
                truncate(ev_txt.trim(), 44),
                Style::default().fg(muted),
            ),
        ])
        .alignment(ratatui::layout::Alignment::Right)
    } else {
        Line::from("").alignment(ratatui::layout::Alignment::Right)
    };

    // ── footer: command pills in the BOTTOM BORDER ──────────────────────
    let btns = buttons(cam_on, mic_on, chat_open);
    let mut f_left = Vec::new();
    for (i, (label, style, action)) in btns.iter().enumerate() {
        if i > 0 {
            f_left.push(Span::styled(" ", Style::default()));
        }
        // " c Cam ON " → key + name, single pill bg
        let (key, rest) = label[1..].split_once(']').unwrap_or((label, ""));
        let _ = action;
        f_left.push(Span::styled(
            format!(" {} ", key),
            Style::default().fg(accent).add_modifier(bold),
        ));
        f_left.push(Span::styled(
            format!("{} ", rest),
            (*style).patch(Style::default()),
        ));
    }
    let stats = if rtt > 0 {
        format!(" {}fps {}x{} · {}ms ", fps, enc.0, enc.1, rtt)
    } else {
        format!(" {}fps {}x{} ", fps, enc.0, enc.1)
    };
    let f_right = Line::from(Span::styled(stats, Style::default().fg(muted)))
        .alignment(ratatui::layout::Alignment::Right);

    // ── chat panel content ───────────────────────────────────────────────
    let mut msg_items: Vec<Line> = Vec::new();
    if sidebar {
        let wrap_w = (SIDEBAR_W.saturating_sub(6)) as usize;
        for m in chat_log.iter().rev().take(120) {
            let name_c = if m.mine { accent } else { ok };
            let prefix = format!("{}: ", truncate(&m.name, 10));
            let body = format!("{}{}", prefix, m.text);
            let (l1, l2) = wrap_at(&body, wrap_w);
            msg_items.push(Line::from(Span::styled(l1, Style::default().fg(name_c))));
            if let Some(rest) = l2 {
                msg_items.push(Line::from(Span::styled(
                    format!("  {}", rest),
                    Style::default().fg(muted),
                )));
            }
        }
        // keep the newest `msg_h` lines
        let cap = (rows.saturating_sub(9)).max(1) as usize;
        while msg_items.len() > cap {
            msg_items.remove(0);
        }
    }

    let _ = term.draw(|f| {
        // Outer frame: rounded, header + footer live in its borders.
        let outer = Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(border))
            .style(Style::default().bg(Color::Rgb(10, 11, 14)))
            .title_top(h_left)
            .title_top(h_right)
            .title_bottom(Line::from(f_left.clone()))
            .title_bottom(f_right);
        f.render_widget(&outer, area);
        let inner = outer.inner(area);

        // Tile labels over the video (clamped so names never clip).
        let label = |name: &str, off: bool| -> Line<'static> {
            let txt = if off {
                format!(" {} · cam off ", truncate(name, 18))
            } else {
                format!(" {} ", truncate(name, 18))
            };
            Line::from(Span::styled(
                txt,
                Style::default().fg(Color::White).bg(Color::Rgb(10, 11, 14)),
            ))
        };
        let (gcols, grows) = *TILE_GRID.lock().unwrap_or_else(|e| e.into_inner());
        let tnames = TILE_NAMES.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let (ox, oy, cw, ch) = *TILE_METRICS.lock().unwrap_or_else(|e| e.into_inner());
        let mut labels: Vec<(u16, u16, Line)> = Vec::new();
        for (i, name) in tnames.iter().enumerate() {
            let gx = (i as u16) % gcols.max(1);
            let gy = (i as u16) / gcols.max(1);
            if gx >= gcols || gy >= grows {
                break;
            }
            let off = i == 0 && !cam_on;
            labels.push((ox + gx * cw, oy + gy * ch, label(name, off)));
        }
        let right_edge = if sidebar { sb_x } else { inner.right() };
        for (x, y, line) in &labels {
            let w = line.width() as u16;
            let x = (*x).max(2).min(right_edge.saturating_sub(w + 1));
            f.render_widget(
                Paragraph::new(line.clone()),
                Rect { x, y: *y, width: w, height: 1 },
            );
        }

        // Idle state hint (bottom-left of the video region).
        if tnames.len() <= 1 {
            let hint = "alone in the room — share the code";
            f.render_widget(
                Paragraph::new(Line::from(Span::styled(hint, Style::default().fg(muted)))),
                Rect {
                    x: 2,
                    y: inner.bottom() - 1,
                    width: hint.len() as u16,
                    height: 1,
                },
            );
        }

        // ── Chat panel: a real bordered block with a close title ─────────
        if sidebar {
            let sb = Rect {
                x: sb_x,
                y: inner.y,
                width: SIDEBAR_W,
                height: inner.height,
            };
            let sb_block = Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded)
                .border_style(Style::default().fg(accent))
                .style(Style::default().bg(panel_bg))
                .title_top(
                    Line::from(Span::styled(
                        " Chat ",
                        Style::default().fg(accent).add_modifier(bold),
                    ))
                    .alignment(ratatui::layout::Alignment::Left),
                )
                .title_top(
                    Line::from(Span::styled(
                        " x ",
                        Style::default().fg(err).add_modifier(bold),
                    ))
                    .alignment(ratatui::layout::Alignment::Right),
                );
            f.render_widget(Clear, sb);
            f.render_widget(&sb_block, sb);
            let sb_inner = sb_block.inner(sb);

            // Messages list (wrapped, newest at bottom)
            let msg_area = Rect {
                x: sb_inner.x,
                y: sb_inner.y,
                width: sb_inner.width,
                height: sb_inner.height.saturating_sub(3),
            };
            let items: Vec<ListItem> = msg_items
                .iter()
                .map(|l| ListItem::new(l.clone()))
                .collect();
            let list = List::new(items).style(Style::default().bg(panel_bg));
            f.render_stateful_widget(list, msg_area, &mut ListState::default());

            // Input: a bordered field at the bottom of the panel
            let in_area = Rect {
                x: sb_inner.x,
                y: sb_inner.bottom().saturating_sub(3),
                width: sb_inner.width,
                height: 3,
            };
            let in_block = Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded)
                .border_style(Style::default().fg(if input_txt.is_empty() { muted } else { accent }))
                .title_top(Line::from(Span::styled(
                    " message — enter sends, esc closes ",
                    Style::default().fg(muted),
                )));
            f.render_widget(&in_block, in_area);
            let in_inner = in_block.inner(in_area);
            let in_line = if input_txt.is_empty() {
                Line::from(Span::styled("…", Style::default().fg(muted)))
            } else {
                Line::from(vec![
                    Span::styled(input_txt.clone(), Style::default().fg(text_c)),
                    Span::styled("▊", Style::default().fg(accent)),
                ])
            };
            f.render_widget(
                Paragraph::new(in_line),
                Rect { x: in_inner.x, y: in_inner.y, width: in_inner.width, height: 1 },
            );
        }
    });

    // Click targets: footer pills (in the bottom border row) + chat [x].
    let mut rects = button_layout(cam_on, mic_on, chat_open, rows.saturating_sub(1));
    if sidebar {
        rects.push((
            Rect {
                x: sb_x + SIDEBAR_W - 5,
                y: 1,
                width: 4,
                height: 1,
            },
            Action::CloseChat,
        ));
    }
    *BUTTONS.lock().unwrap_or_else(|e| e.into_inner()) = rects;
}

/// The five deck buttons: label carries the keyboard shortcut, colour the
/// state (green = on, red = off/leave, cyan = copy/chat).
fn buttons(cam_on: bool, mic_on: bool, chat_open: bool) -> Vec<(String, Style, Action)> {
    use ratatui::style::Color;
    // Pill: bg = state color, fg = near-black. Lip Gloss look in one row.
    let pill = |bg: Color, on: bool| {
        Style::default()
            .fg(if on { Color::Rgb(10, 11, 14) } else { Color::White })
            .bg(bg)
            .add_modifier(Modifier::BOLD)
    };
    let on_off = |on: bool| pill(if on { ok_c() } else { err_c() }, on);
    vec![
        (
            if cam_on { " c Cam on " } else { " c Cam off " }.to_string(),
            on_off(cam_on),
            Action::ToggleCamera,
        ),
        (
            if mic_on { " m Mic on " } else { " m Mic off " }.to_string(),
            on_off(mic_on),
            Action::ToggleMic,
        ),
        (
            " t Chat ".to_string(),
            pill(accent_c(), chat_open),
            Action::OpenChat,
        ),
        (
            " y Copy code ".to_string(),
            pill(cyan_c(), false),
            Action::CopyCode,
        ),
        (
            " q Leave ".to_string(),
            pill(err_c(), false),
            Action::Leave,
        ),
    ]
}

fn ok_c() -> ratatui::style::Color {
    ratatui::style::Color::Rgb(152, 195, 121)
}
fn err_c() -> ratatui::style::Color {
    ratatui::style::Color::Rgb(224, 108, 117)
}
fn cyan_c() -> ratatui::style::Color {
    ratatui::style::Color::Rgb(86, 182, 194)
}
fn accent_c() -> ratatui::style::Color {
    ratatui::style::Color::Rgb(125, 86, 244)
}

/// Hit rects for the button row, derived from the same labels that get
/// painted (labels are pure ASCII, so char count == display width).
/// 2-space gaps; 2-space left indent. `y` in absolute screen coords.
fn button_layout(cam_on: bool, mic_on: bool, chat_open: bool, y: u16) -> Vec<(Rect, Action)> {
    let mut rects = Vec::new();
    let mut x: u16 = 2; // inside the rounded border, 1 pad from the corner
    for (label, _, action) in buttons(cam_on, mic_on, chat_open) {
        let w = label.chars().count() as u16;
        rects.push((Rect { x, y, width: w, height: 1 }, action));
        x += w + 1; // gap, matches the painted " "
    }
    rects
}

/// SGR mouse coords are 1-based; rects are 0-based.
fn hit_test(x: u16, y: u16) -> Option<Action> {
    let px = x.saturating_sub(1);
    let py = y.saturating_sub(1);
    for (rect, action) in BUTTONS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
    {
        if py == rect.y && px >= rect.x && px < rect.x + rect.width {
            return Some(action.clone());
        }
    }
    None
}

// ── Input thread: kitty ACKs + mouse + keys from one stdin stream ────────

pub fn start_input_thread() {
    INPUT_STARTED.call_once(|| {
        std::thread::Builder::new()
            .name("ui-input".into())
            .spawn(input_loop)
            .expect("input thread");
    });
}

fn input_loop() {
    use std::io::Read;
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut chunk = [0u8; 1024];
    loop {
        // Blocking read; the process exits via process::exit on teardown.
        let n = match std::io::stdin().read(&mut chunk) {
            Ok(0) => return, // stdin closed (parent gone)
            Ok(n) => n,
            Err(_) => return,
        };
        buf.extend_from_slice(&chunk[..n]);

        // Parse everything we can.
        loop {
            match parse_one(&mut buf) {
                Parsed::Skip => break,
                Parsed::Ack => {
                    ACKED.fetch_add(1, Ordering::SeqCst);
                }
                Parsed::KittyError(msg) => {
                    let mut errs = KITTY_ERRORS.lock().unwrap_or_else(|e| e.into_inner());
                    if errs.last().map(|s| s.as_str()) != Some(msg.as_str()) {
                        errs.push(msg);
                    }
                }
                Parsed::Click(x, y) => {
                    if let Some(a) = hit_test(x, y) {
                        push_action(a);
                    }
                }
                Parsed::Key(b) => handle_key(b),
                Parsed::Skip => {}
            }
            if buf.is_empty() {
                break;
            }
        }
    }
}

enum Parsed {
    /// Consumed nothing — wait for more bytes.
    Skip,
    /// One kitty graphics ACK (OK).
    Ack,
    /// A kitty ACK carrying an error status.
    KittyError(String),
    /// SGR mouse press at (col, row), both 1-based.
    Click(u16, u16),
    /// A plain key byte.
    Key(u8),
}

/// Consume one logical event from the head of `buf`.
fn parse_one(buf: &mut Vec<u8>) -> Parsed {
    if buf.is_empty() {
        return Parsed::Skip;
    }
    match buf[0] {
        0x1b => {
            // Need at least 2 bytes to classify.
            if buf.len() < 2 {
                return Parsed::Skip;
            }
            match buf[1] {
                b'_' => {
                    // Kitty graphics reply: ESC _ G ... ESC \
                    let Some(pos) = find_terminator(buf) else {
                        return Parsed::Skip; // wait for the terminator
                    };
                    let body = String::from_utf8_lossy(&buf[0..pos + 2]).to_string();
                    buf.drain(..pos + 2);
                    // Count every graphics reply as one ack; surface errors.
                    if let Some(status) = body
                        .split_once(';')
                        .map(|(_, s)| s.trim_end_matches("\u{1b}\\"))
                    {
                        if !status.is_empty() && status != "OK" {
                            let printable: String = status
                                .chars()
                                .filter(|&c| c.is_ascii_graphic() || c == ' ')
                                .collect();
                            return Parsed::KittyError(printable);
                        }
                    }
                    Parsed::Ack
                }
                b'[' if buf.len() > 2 && buf[2] == b'<' => {
                    // SGR mouse: ESC [ < b ; x ; y M|m
                    let Some(end) = buf
                        .iter()
                        .position(|&b| b == b'M' || b == b'm')
                    else {
                        return Parsed::Skip;
                    };
                    let seq = String::from_utf8_lossy(&buf[3..end]).to_string();
                    let is_press = buf[end] == b'M';
                    buf.drain(..=end);
                    let parts: Vec<&str> = seq.split(';').collect();
                    if parts.len() == 3 && is_press {
                        let b: u32 = parts[0].parse().unwrap_or(u32::MAX);
                        let x: u16 = parts[1].parse().unwrap_or(0);
                        let y: u16 = parts[2].parse().unwrap_or(0);
                        let button = b & 0b11;
                        let motion = b & 32 != 0;
                        if button == 0 && !motion {
                            return Parsed::Click(x, y);
                        }
                    }
                    Parsed::Skip
                }
                b'[' => {
                    // Unknown CSI: skip to the final byte (0x40..=0x7e).
                    let Some(end) = buf
                        .iter()
                        .skip(2)
                        .position(|&b| (0x40..=0x7e).contains(&b))
                        .map(|p| p + 2)
                    else {
                        return Parsed::Skip;
                    };
                    buf.drain(..=end);
                    Parsed::Skip
                }
                0x5f => {
                    // ESC _ without G yet — wait (kitty replies always start G).
                    Parsed::Skip
                }
                0x5d => {
                    // OSC (ESC ] … BEL or ESC \): Termius and friends emit
                    // title/config sequences on stdin — never user text.
                    let bel = buf.iter().position(|&b| b == 0x07);
                    let st = find_terminator(buf);
                    match (bel, st) {
                        (Some(p), _) => {
                            buf.drain(..=p);
                            Parsed::Skip
                        }
                        (None, Some(p)) => {
                            buf.drain(..p + 2);
                            Parsed::Skip
                        }
                        (None, None) => Parsed::Skip, // wait for the terminator
                    }
                }
                0x50 => {
                    // DCS (ESC P … ESC \): same treatment.
                    let Some(p) = find_terminator(buf) else {
                        return Parsed::Skip;
                    };
                    buf.drain(..p + 2);
                    Parsed::Skip
                }
                _ => {
                    // Bare ESC (or unknown escape): drop it.
                    buf.remove(0);
                    Parsed::Skip
                }
            }
        }
        b => {
            buf.remove(0);
            Parsed::Key(b)
        }
    }
}

/// Index of the kitty reply terminator (ESC \).
fn find_terminator(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == [0x1b, b'\\'])
}

// ── Mouse capture / teardown ─────────────────────────────────────────────

pub fn enter_ui() {
    use std::io::Write;
    let _ = write!(
        std::io::stdout(),
        "\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?25l"
    ); // mouse press+drag+SGR, hide cursor
    let _ = std::io::stdout().flush();
}

/// Force the next paint to re-emit the whole frame (after screen clears —
/// ratatui's diff buffer must be dropped, or cleared cells stay blank).
pub fn reset_terminal() {
    *TERMINAL.lock().unwrap_or_else(|e| e.into_inner()) = None;
    *LAST_AREA.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

pub fn exit_ui() {
    use std::io::Write;
    // Drop the ratatui terminal + hit regions.
    *TERMINAL.lock().unwrap_or_else(|e| e.into_inner()) = None;
    *LAST_AREA.lock().unwrap_or_else(|e| e.into_inner()) = None;
    BUTTONS.lock().unwrap_or_else(|e| e.into_inner()).clear();
    let _ = write!(std::io::stdout(), "\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?25h");
    // Wipe the whole frame so the shell prompt starts clean.
    let _ = write!(std::io::stdout(), "\x1b[2J\x1b[H");
    let _ = std::io::stdout().flush();
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_kitty_acks() {
        let mut buf: Vec<u8> = format!("\u{1b}_Gi=1;OK\u{1b}\\").into_bytes();
        assert!(matches!(parse_one(&mut buf), Parsed::Ack));
        assert!(buf.is_empty());
        // Two acks in one chunk.
        let mut b2: Vec<u8> = format!(
            "\u{1b}_Gi=1;OK\u{1b}\\\u{1b}_Gi=2;OK\u{1b}\\"
        )
        .into_bytes();
        assert!(matches!(parse_one(&mut b2), Parsed::Ack));
        assert!(matches!(parse_one(&mut b2), Parsed::Ack));
        assert!(b2.is_empty());
    }

    #[test]
    fn parses_kitty_errors() {
        let mut buf: Vec<u8> = format!("\u{1b}_Gi=1;EINVAL:bad\u{1b}\\").into_bytes();
        match parse_one(&mut buf) {
            Parsed::KittyError(s) => assert!(s.contains("EINVAL")),
            _ => panic!("expected kitty error"),
        }
        assert!(buf.is_empty());
    }

    #[test]
    fn parses_partial_then_more() {
        let mut buf: Vec<u8> = vec![0x1b, b'_', b'G', b'i'];
        assert!(matches!(parse_one(&mut buf), Parsed::Skip));
        buf.extend_from_slice(b"=1;OK\x1b\\");
        assert!(matches!(parse_one(&mut buf), Parsed::Ack));
        assert!(buf.is_empty());
    }

    #[test]
    fn parses_sgr_click() {
        let mut buf: Vec<u8> = b"\x1b[<0;12;40M".to_vec();
        match parse_one(&mut buf) {
            Parsed::Click(x, y) => {
                assert_eq!(x, 12);
                assert_eq!(y, 40);
            }
            _ => panic!("expected click"),
        }
        // Release events are ignored.
        let mut rel: Vec<u8> = b"\x1b[<0;12;40m".to_vec();
        assert!(matches!(parse_one(&mut rel), Parsed::Skip));
        // Motion is ignored.
        let mut mov: Vec<u8> = b"\x1b[<32;12;40M".to_vec();
        assert!(matches!(parse_one(&mut mov), Parsed::Skip));
    }

    #[test]
    fn parses_keys_and_ctrl_c() {
        let mut buf = b"qc".to_vec();
        assert!(matches!(parse_one(&mut buf), Parsed::Key(b'q')));
        assert!(matches!(parse_one(&mut buf), Parsed::Key(b'c')));
        let mut ctrlc = vec![0x03u8];
        assert!(matches!(parse_one(&mut ctrlc), Parsed::Key(0x03)));
    }

    #[test]
    fn typing_mode_captures_keys() {
        // 't' opens chat; keys build the buffer; Enter emits SendChat.
        handle_key(b't');
        assert!(TYPING.load(Ordering::SeqCst));
        for b in b"hi ther".iter() {
            handle_key(*b);
        }
        handle_key(0x7f); // backspace eats 'r'
        handle_key(b'!');
        for _ in 0..2 {
            let _ = ACTIONS.lock().unwrap_or_else(|e| e.into_inner()).pop_front();
        }
        handle_key(0x0d); // Enter
        let sent = poll_action();
        assert_eq!(
            sent,
            Some(Action::SendChat("hi the!".to_string())),
            "backspace + text + Enter"
        );
        // Esc closes and clears.
        handle_key(0x1b);
        assert!(!TYPING.load(Ordering::SeqCst));
        set_typing(true);
        handle_key(b'x');
        handle_key(0x1b);
        // Ctrl+C quits even while typing.
        set_typing(true);
        handle_key(0x03);
        assert_eq!(poll_action(), Some(Action::Leave));
        set_typing(false);
    }

    #[test]
    fn video_width_reflows_with_sidebar() {
        set_typing(false);
        assert_eq!(video_cols(140), 138); // frame insets only
        set_typing(true);
        assert_eq!(video_cols(140), 138 - SIDEBAR_W); // sidebar steals columns
        assert_eq!(video_cols(80), 78); // narrow: bottom-panel chat, full width
        set_typing(false);
        assert_eq!(video_cols(140), 138);
        assert_eq!(deck_rows(), 3); // chrome never changes with the sidebar
    }

    #[test]
    fn hit_test_maps_columns() {
        let rows = 40u16;
        *BUTTONS.lock().unwrap_or_else(|e| e.into_inner()) =
            button_layout(true, true, false, rows - 1);
        // Pills: ` c Cam on `(10) + 1 gap → ` m Mic on `(10) + gap →
        // ` t Chat `(8) + gap → ` y Copy code `(13) + gap → ` q Leave `(9).
        assert_eq!(
            BUTTONS.lock().unwrap()[0].0,
            Rect { x: 2, y: rows - 1, width: 10, height: 1 }
        );
        // SGR coords are 1-based.
        assert_eq!(hit_test(3, rows), Some(Action::ToggleCamera));
        assert_eq!(hit_test(11, rows), Some(Action::ToggleCamera)); // last CAM cell
        assert_eq!(hit_test(14, rows), Some(Action::ToggleMic));
        assert_eq!(hit_test(26, rows), Some(Action::OpenChat));
        assert_eq!(hit_test(37, rows), Some(Action::CopyCode));
        assert_eq!(hit_test(52, rows), Some(Action::Leave));
        assert_eq!(hit_test(52, rows - 2), None); // wrong row (footer row = rows-1)
        assert_eq!(hit_test(95, rows), None); // beyond all buttons
        // Off-state pills are wider — rects must track the state.
        let off = button_layout(false, false, false, rows - 1);
        assert_eq!(off[0].0.width, 11); // " c Cam off "
        assert_eq!(off[1].0.x, off[0].0.x + 12);
        BUTTONS.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}