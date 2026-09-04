// ANSI truecolor renderers for terminal video.
//
// Two methods:
//
// 1. render_ansi      — half-block  (▀): 1 char = 2 vertical pixels  (1x2)
// 2. render_quadrant  — quadrant blocks: 1 char = 2x2 pixels (4x detail)
//
// The quadrant character set (U+2580..U+259F) encodes every 2x2 on/off
// pattern with a foreground + background color, giving 4 pixels per cell
// — double the spatial resolution of half-blocks in both axes.
//
// Truecolor ANSI: ESC[38;2;R;G;Bm (fg) and ESC[48;2;R;G;Bm (bg).

use std::fmt::Write as _;

/// Quadrant glyph lookup. Pixel bit order: bit0=UL, bit1=UR, bit2=LL, bit3=LR.
const QUADRANT: [char; 16] = [
    ' ',  // 0000
    '▘',  // 0001 UL
    '▝',  // 0010 UR
    '▀',  // 0011 top
    '▖',  // 0100 LL
    '▌',  // 0101 UL+LL
    '▞',  // 0110 UR+LL
    '▛',  // 0111 UL+UR+LL
    '▗',  // 1000 LR
    '▚',  // 1001 UL+LR
    '▐',  // 1010 UR+LR
    '▜',  // 1011 UL+UR+LR
    '▄',  // 1100 LL+LR
    '▙',  // 1101 UL+LL+LR
    '▟',  // 1110 UR+LL+LR
    '█',  // 1111 full
];

#[inline]
fn lum(r: u8, g: u8, b: u8) -> u32 {
    299 * r as u32 + 587 * g as u32 + 114 * b as u32
}

/// Render an RGB frame as ANSI half-block truecolor art (1 char = 2 px tall).
///
/// Optimizations: `write!()` straight into the String buffer (no per-pixel
/// `format!` allocation) and redundant escape codes are skipped when the
/// fg/bg color is unchanged from the previous cell in the row.
pub fn render_ansi(rgb: &[u8], width: usize, height: usize) -> String {
    let display_height = height / 2;
    let mut out = String::with_capacity(display_height * width * 20);

    let mut last_fg: Option<(u8, u8, u8)> = None;
    let mut last_bg: Option<(u8, u8, u8)> = None;

    for row in 0..display_height {
        let y_top = (row * 2).min(height - 1);
        let y_bot = (y_top + 1).min(height - 1);

        if row > 0 {
            out.push_str("\x1b[0m\r\n");
            last_fg = None;
            last_bg = None;
        }

        for col in 0..width {
            let top_i = (y_top * width + col) * 3;
            let bot_i = (y_bot * width + col) * 3;

            let fg = (rgb[top_i], rgb[top_i + 1], rgb[top_i + 2]);
            let bg = (rgb[bot_i], rgb[bot_i + 1], rgb[bot_i + 2]);

            if Some(fg) != last_fg {
                write!(out, "\x1b[38;2;{};{};{}m", fg.0, fg.1, fg.2).unwrap();
                last_fg = Some(fg);
            }
            if Some(bg) != last_bg {
                write!(out, "\x1b[48;2;{};{};{}m", bg.0, bg.1, bg.2).unwrap();
                last_bg = Some(bg);
            }
            out.push('▀');
        }
    }
    out.push_str("\x1b[0m");
    out
}

/// Render an RGB frame as ANSI QUADRANT truecolor art (1 char = 2x2 pixels).
///
/// Input must be the display-resolution image (width and height even).
/// For every 2x2 pixel cell:
///   - split the 4 pixels into a dark pair and a light pair by luminance,
///   - fg = average of the light pair, bg = average of the dark pair,
///   - choose the quadrant glyph whose pattern best matches which pixels
///     are closer to fg vs bg.
/// This yields 4 spatial samples per character cell — same sub-pixel density
/// as what makes chafa's output look detailed, at a fraction of the cost.
pub fn render_quadrant(rgb: &[u8], width: usize, height: usize) -> String {
    let cols = width / 2;
    let rows = height / 2;
    let mut out = String::with_capacity(rows * cols * 20);

    let mut last_fg: Option<(u8, u8, u8)> = None;
    let mut last_bg: Option<(u8, u8, u8)> = None;

    for cy in 0..rows {
        if cy > 0 {
            out.push_str("\x1b[0m\r\n");
            last_fg = None;
            last_bg = None;
        }
        let y0 = cy * 2;
        let y1 = y0 + 1;

        for cx in 0..cols {
            let x0 = cx * 2;
            let x1 = x0 + 1;

            // Fetch the 2x2 pixel block
            let i00 = (y0 * width + x0) * 3;
            let i01 = (y0 * width + x1) * 3;
            let i10 = (y1 * width + x0) * 3;
            let i11 = (y1 * width + x1) * 3;

            let p = [
                (rgb[i00], rgb[i00 + 1], rgb[i00 + 2]),
                (rgb[i01], rgb[i01 + 1], rgb[i01 + 2]),
                (rgb[i10], rgb[i10 + 1], rgb[i10 + 2]),
                (rgb[i11], rgb[i11 + 1], rgb[i11 + 2]),
            ];

            // Split into dark/light pairs by luminance
            let mut idx = [0usize, 1, 2, 3];
            idx.sort_by_key(|&i| lum(p[i].0, p[i].1, p[i].2));

            let mut bg = [0u32; 3];
            let mut fg = [0u32; 3];
            for c in 0..3 {
                bg[c] = (p[idx[0]].c(c) as u32 + p[idx[1]].c(c) as u32) / 2;
                fg[c] = (p[idx[2]].c(c) as u32 + p[idx[3]].c(c) as u32) / 2;
            }
            let bg = (bg[0] as u8, bg[1] as u8, bg[2] as u8);
            let fg = (fg[0] as u8, fg[1] as u8, fg[2] as u8);

            // Build 2x2 on/off bitmap: pixel closer to fg than bg -> bit set
            let bg_l: i32 = lum(bg.0, bg.1, bg.2) as i32;
            let fg_l: i32 = lum(fg.0, fg.1, fg.2) as i32;
            // Guard: identical colors -> full block with bg color only
            let mut bits = 0u8;
            for (bit, pi) in p.iter().enumerate() {
                let l = lum(pi.0, pi.1, pi.2) as i32;
                let df = (l - fg_l).abs();
                let db = (l - bg_l).abs();
                if df <= db {
                    bits |= 1 << bit;
                }
            }

            // Handle fg == bg (flat cell): force full block, skip fg code
            let flat = fg == bg;
            let glyph = QUADRANT[bits as usize];

            if Some(bg) != last_bg {
                write!(out, "\x1b[48;2;{};{};{}m", bg.0, bg.1, bg.2).unwrap();
                last_bg = Some(bg);
            }
            if flat {
                // All-same color: full block using background only
                out.push_str("\x1b[38;2;");
                write!(out, "{};{};{}m", bg.0, bg.1, bg.2).unwrap();
                out.push('█');
                last_fg = Some(bg);
            } else {
                if Some(fg) != last_fg {
                    write!(out, "\x1b[38;2;{};{};{}m", fg.0, fg.1, fg.2).unwrap();
                    last_fg = Some(fg);
                }
                out.push(glyph);
            }
        }
    }
    out.push_str("\x1b[0m");
    out
}

trait Chan {
    fn c(&self, i: usize) -> u8;
}
impl Chan for (u8, u8, u8) {
    #[inline]
    fn c(&self, i: usize) -> u8 {
        match i {
            0 => self.0,
            1 => self.1,
            _ => self.2,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_render_ansi_produces_output() {
        let width = 4;
        let height = 4; // -> 2 half-block rows
        let mut rgb = vec![0u8; width * height * 3];
        for i in 0..(width * height) {
            rgb[i * 3] = 255;
            rgb[i * 3 + 1] = 0;
            rgb[i * 3 + 2] = 0;
        }
        let result = render_ansi(&rgb, width, height);
        assert!(result.contains('▀'));
        assert!(result.contains("\x1b[38;2;255;0;0m"));
        assert_eq!(result.lines().count(), 2);
    }

    #[test]
    fn test_color_skip_optimization() {
        // All same color → only one fg + one bg escape for the whole frame
        let width = 10;
        let height = 4;
        let rgb = vec![128u8; width * height * 3];
        let result = render_ansi(&rgb, width, height);
        let fg_count = result.matches("\x1b[38;2;").count();
        let bg_count = result.matches("\x1b[48;2;").count();
        // One fg + one bg per row (2 rows) — within a row, codes are skipped
        assert_eq!(fg_count, 2, "one fg code per row, none repeated inline");
        assert_eq!(bg_count, 2, "one bg code per row, none repeated inline");
        assert_eq!(result.matches('▀').count(), 20); // 10 per row * 2 rows
    }

    #[test]
    fn test_gradient_colors() {
        let width = 4;
        let height = 4;
        let mut rgb = vec![0u8; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let i = (y * width + x) * 3;
                rgb[i] = (x * 63) as u8;
                rgb[i + 1] = (y * 63) as u8;
                rgb[i + 2] = 128;
            }
        }
        let result = render_ansi(&rgb, width, height);
        assert!(result.contains("\x1b[38;2;"));
    }

    #[test]
    fn test_quadrant_flat() {
        // Uniform color → every cell is full block █, one fg/bg pair per row
        let width = 4;
        let height = 4; // 2x2 cells
        let rgb = vec![10u8; width * height * 3];
        let result = render_quadrant(&rgb, width, height);
        assert_eq!(result.matches('█').count(), 4);
        // 2 rows → 2 bg emissions (reset per row)
        assert_eq!(result.matches("\x1b[48;2;10;10;10m").count(), 2);
        assert!(result.contains("\x1b[38;2;10;10;10m"));
    }

    #[test]
    fn test_quadrant_split() {
        // Even rows black, odd rows white → each cell has dark top, light
        // bottom → glyph ▄ (lower half light)
        let width = 2;
        let height = 4; // 1 col x 2 rows of quadrant cells
        let mut rgb = vec![0u8; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let i = (y * width + x) * 3;
                if y % 2 == 1 {
                    rgb[i] = 255;
                    rgb[i + 1] = 255;
                    rgb[i + 2] = 255;
                }
            }
        }
        let result = render_quadrant(&rgb, width, height);
        // Both cells (top of each cell dark, bottom light) should be ▄
        assert_eq!(result.matches('▄').count(), 2);
        assert!(result.contains("\x1b[38;2;255;255;255m"));
        assert!(result.contains("\x1b[48;2;0;0;0m"));
    }

    #[test]
    fn test_quadrant_diagonal() {
        // UL black, UR white, LL white, LR black -> ▞
        let width = 2;
        let height = 2;
        let mut rgb = vec![0u8; width * height * 3];
        rgb[0] = 255;
        rgb[1] = 0;
        rgb[2] = 0; // UL red (dark)
        rgb[3] = 255;
        rgb[4] = 255;
        rgb[5] = 255; // UR white (light)
        rgb[6] = 255;
        rgb[7] = 255;
        rgb[8] = 255; // LL white (light)
        rgb[9] = 0;
        rgb[10] = 0;
        rgb[11] = 0; // LR black (dark)
        let result = render_quadrant(&rgb, width, height);
        assert!(result.contains('▞'), "expected diagonal glyph: {result}");
    }
}