// ANSI half-block truecolor renderer.
//
// Converts an RGB pixel buffer into ANSI escape sequences using Unicode
// half-block characters. Each character cell renders two vertical pixels:
// foreground = top pixel, background = bottom pixel.
// Doubles vertical resolution: an 80x40 terminal renders 80x80 pixels.
//
// Truecolor ANSI: ESC[38;2;R;G;Bm (fg) and ESC[48;2;R;G;Bm (bg).

/// Render an RGB frame as ANSI half-block truecolor art.
pub fn render_ansi(rgb: &[u8], width: usize, height: usize) -> String {
    let display_height = height / 2;
    let mut out = String::with_capacity(display_height * width * 24);

    for row in 0..display_height {
        let y_top = (row * 2).min(height - 1);
        let y_bot = (y_top + 1).min(height - 1);

        if row > 0 {
            out.push_str("\x1b[0m\r\n");
        }

        for col in 0..width {
            let top_i = (y_top * width + col) * 3;
            let bot_i = (y_bot * width + col) * 3;

            out.push_str(&format!(
                "\x1b[38;2;{};{};{}m\x1b[48;2;{};{};{}m\u{2580}",
                rgb[top_i], rgb[top_i + 1], rgb[top_i + 2],
                rgb[bot_i], rgb[bot_i + 1], rgb[bot_i + 2],
            ));
        }
    }
    out.push_str("\x1b[0m");
    out
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
        assert!(result.contains("\u{2580}"));
        assert!(result.contains("\x1b[38;2;255;0;0m"));
        assert_eq!(result.lines().count(), 2);
    }

    #[test]
    fn test_solid_color_batched() {
        let width = 10;
        let height = 4;
        let mut rgb = vec![0u8; width * height * 3];
        for i in 0..(width * height) {
            rgb[i * 3] = 0;
            rgb[i * 3 + 1] = 0;
            rgb[i * 3 + 2] = 255;
        }
        let result = render_ansi(&rgb, width, height);
        assert!(result.contains("\x1b[38;2;0;0;255m"));
        let count = result.matches("\u{2580}").count();
        assert_eq!(count, 20); // 10 per row * 2 rows
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
}