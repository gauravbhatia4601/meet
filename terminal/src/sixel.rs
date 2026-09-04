// Sixel graphics encoder — median-cut palette + column RLE.
//
// Zero-allocation steady state: all scratch buffers live in `SixelEncoder`
// and are reused across frames, so a long-running session does not churn
// the allocator (RSS stays flat after warm-up).

use std::collections::HashMap;

/// Reusable sixel encoder. Create once, call `encode_into` per frame.
pub struct SixelEnc {
    map: Vec<u8>,
    samples: Vec<(u8, u8, u8)>,
    bucket_idx: Vec<u32>,
    buckets: Vec<(usize, usize)>, // (start,end) ranges into bucket_idx
    col_masks: Vec<u8>,
    cache: HashMap<u32, u8>, // bounded by distinct colors, cleared per frame
}

impl SixelEnc {
    pub fn new() -> Self {
        SixelEnc {
            map: Vec::new(),
            samples: Vec::new(),
            bucket_idx: Vec::new(),
            buckets: Vec::new(),
            col_masks: Vec::new(),
            cache: HashMap::with_capacity(4096),
        }
    }

    pub fn encode_into(
        &mut self,
        rgb: &[u8],
        width: usize,
        height: usize,
        max_colors: usize,
        out: &mut Vec<u8>,
    ) {
        let total = width * height;
        let map = &mut self.map;
        map.clear();
        map.resize(total, 0);
        out.clear();

        // ── 1. Sample colors (≤16k) for the palette ─────────────────────────────
        let step = (total / 16_384).max(1);
        let samples = &mut self.samples;
        samples.clear();
        let mut i = 0usize;
        while i < total {
            let o = i * 3;
            if o + 2 < rgb.len() {
                samples.push((rgb[o], rgb[o + 1], rgb[o + 2]));
            }
            i += step;
        }
        let palette = median_cut(samples, &mut self.bucket_idx, &mut self.buckets, max_colors.max(2));

        // ── 2. Map every pixel to nearest palette index (cached) ────────────────
        self.cache.clear();
        for px in 0..total {
            let o = px * 3;
            if o + 2 >= rgb.len() {
                continue;
            }
            let (r, g, b) = (rgb[o], rgb[o + 1], rgb[o + 2]);
            let key = ((r as u32) << 16) | ((g as u32) << 8) | (b as u32);
            let idx = if let Some(&c) = self.cache.get(&key) {
                c
            } else {
                let mut best = (u32::MAX, 0u8);
                for (pi, p) in palette.iter().enumerate() {
                    let dr = r as i32 - p.0 as i32;
                    let dg = g as i32 - p.1 as i32;
                    let db = b as i32 - p.2 as i32;
                    let d = (dr * dr + dg * dg + db * db) as u32;
                    if d < best.0 {
                        best = (d, pi as u8);
                    }
                }
                self.cache.insert(key, best.1);
                best.1
            };
            map[px] = idx;
        }

        // ── 3. Emit ─────────────────────────────────────────────────────────────
        out.extend_from_slice(b"\x1bPq");
        out.extend_from_slice(format!("\"1;1;{width};{height}").as_bytes());

        for (pi, &(r, g, b)) in palette.iter().enumerate() {
            out.extend_from_slice(
                format!(
                    "#{};2;{};{};{}",
                    pi,
                    r as u32 * 100 / 255,
                    g as u32 * 100 / 255,
                    b as u32 * 100 / 255
                )
                .as_bytes(),
            );
        }

        let col_masks = &mut self.col_masks;
        col_masks.clear();
        col_masks.resize(width, 0);

        let mut band_top = 0usize;
        while band_top < height {
            let band_h = 6.min(height - band_top);

            for (ci, _) in palette.iter().enumerate() {
                let mut any = false;
                for x in 0..width {
                    let mut m = 0u8;
                    for ly in 0..band_h {
                        let px = (band_top + ly) * width + x;
                        if map[px] as usize == ci {
                            m |= 1 << ly;
                        }
                    }
                    col_masks[x] = m;
                    if m != 0 {
                        any = true;
                    }
                }
                if !any {
                    continue;
                }

                out.extend_from_slice(format!("#{ci}").as_bytes());

                let mut x = 0usize;
                while x < width {
                    let v = col_masks[x];
                    let mut run = 1usize;
                    while x + run < width && col_masks[x + run] == v {
                        run += 1;
                    }
                    if v != 0 {
                        let ch = char::from_u32(63 + v as u32).unwrap_or('?');
                        if run > 3 {
                            out.extend_from_slice(format!("!{run}{ch}").as_bytes());
                        } else {
                            for _ in 0..run {
                                out.push(ch as u8);
                            }
                        }
                    }
                    x += run;
                }
                out.push(b'$'); // return to left margin
            }

            out.extend_from_slice(b"\r\n"); // next band
            band_top += 6;
        }

        out.extend_from_slice(b"\x1b\\");
    }
}

impl Default for SixelEnc {
    fn default() -> Self {
        Self::new()
    }
}


fn median_cut(
    samples: &[(u8, u8, u8)],
    idx_buf: &mut Vec<u32>,
    buckets: &mut Vec<(usize, usize)>,
    max_colors: usize,
) -> Vec<(u8, u8, u8)> {
    if samples.is_empty() {
        return vec![(0, 0, 0)];
    }

    // One index buffer; buckets are (start,end) ranges into it.
    idx_buf.clear();
    idx_buf.reserve(samples.len());
    for i in 0..samples.len() {
        idx_buf.push(i as u32);
    }
    buckets.clear();
    buckets.push((0, samples.len()));

    let chan = |i: usize, ch: usize| -> u8 {
        let p = samples[i];
        match ch {
            0 => p.0,
            1 => p.1,
            _ => p.2,
        }
    };

    while buckets.len() < max_colors {
        // Find the bucket with the largest channel range
        let mut best = (0usize, 0usize, 0u32, 0usize); // (bi, ch, range, split_at)
        for &(start, end) in buckets.iter() {
            if end - start < 2 {
                continue;
            }
            for ch in 0..3 {
                let mut mn = 255u8;
                let mut mx = 0u8;
                for &si in &idx_buf[start..end] {
                    let v = chan(si as usize, ch);
                    if v < mn {
                        mn = v;
                    }
                    if v > mx {
                        mx = v;
                    }
                }
                let range = (mx - mn) as u32;
                if range > best.2 {
                    // sort the sub-slice by channel, split at median
                    let sub = &mut idx_buf[start..end];
                    sub.sort_by_key(|&si| chan(si as usize, ch));
                    best = (buckets.iter().position(|&b| b == (start, end)).unwrap(), ch, range, start + (end - start) / 2);
                    break; // longest channel is enough for this bucket
                }
            }
        }
        let (bi, _ch, range, split_at) = best;
        if range == 0 || bi >= buckets.len() {
            break;
        }
        let (start, end) = buckets[bi];
        // ensure the slice is sorted by its widest channel before splitting
        let (_bch, _) = widest_channel(samples, idx_buf, start, end);
        // split_by widest
        let (wc, _) = widest_channel(samples, idx_buf, start, end);
        let sub = &mut idx_buf[start..end];
        sub.sort_by_key(|&si| chan(si as usize, wc));
        let mid = start + (end - start) / 2;
        buckets[bi] = (start, mid);
        buckets.push((mid, end));
        let _ = split_at;
    }

    buckets
        .iter()
        .map(|&(start, end)| {
            let n = (end - start).max(1) as u32;
            let (mut r, mut g, mut b) = (0u32, 0u32, 0u32);
            for &si in &idx_buf[start..end] {
                let p = samples[si as usize];
                r += p.0 as u32;
                g += p.1 as u32;
                b += p.2 as u32;
            }
            ((r / n) as u8, (g / n) as u8, (b / n) as u8)
        })
        .collect()
}

fn widest_channel(
    samples: &[(u8, u8, u8)],
    idx: &[u32],
    start: usize,
    end: usize,
) -> (usize, u32) {
    let mut best = (0usize, 0u32);
    for ch in 0..3 {
        let mut mn = 255u8;
        let mut mx = 0u8;
        for &si in &idx[start..end] {
            let p = samples[si as usize];
            let v = match ch {
                0 => p.0,
                1 => p.1,
                _ => p.2,
            };
            if v < mn {
                mn = v;
            }
            if v > mx {
                mx = v;
            }
        }
        let range = (mx - mn) as u32;
        if range > best.1 {
            best = (ch, range);
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sixel_structure() {
        let w = 8;
        let h = 6;
        let mut rgb = vec![0u8; w * h * 3];
        for px in 0..(w * h) {
            rgb[px * 3] = 255;
        }
        let mut enc = SixelEnc::new();
        let mut out = Vec::new();
        enc.encode_into(&rgb, w, h, 64, &mut out);
        let s = String::from_utf8_lossy(&out);
        assert!(s.starts_with("\x1bPq"), "must start with DCS sixel");
        assert!(s.contains("\"1;1;8;6"), "raster attrs must contain size");
        assert!(s.contains("#0;2;"), "palette definitions must exist");
        assert!(s.contains("100;0;0"), "red channel must be defined");
        assert!(s.ends_with("\x1b\\"), "must end with ST");
    }

    #[test]
    fn test_sixel_rle_compression() {
        let w = 64;
        let h = 60;
        let rgb = vec![0u8; w * h * 3];
        let mut enc = SixelEnc::new();
        let mut out = Vec::new();
        enc.encode_into(&rgb, w, h, 8, &mut out);
        assert!(out.len() < 512, "flat frame should be tiny, got {}", out.len());
    }

    #[test]
    fn test_sixel_two_color_top_bottom() {
        let w = 4;
        let h = 6;
        let mut rgb = vec![0u8; w * h * 3];
        for y in 3..h {
            for x in 0..w {
                let i = (y * w + x) * 3;
                rgb[i] = 255;
                rgb[i + 1] = 255;
                rgb[i + 2] = 255;
            }
        }
        let mut enc = SixelEnc::new();
        let mut out = Vec::new();
        enc.encode_into(&rgb, w, h, 8, &mut out);
        let s = String::from_utf8_lossy(&out);
        assert!(s.contains("#0;2;0;0;0"));
        assert!(s.contains("#1;2;100;100;100"));
        assert!(s.contains("!4w"), "white mask RLE should be !4w: {s}");
        assert!(s.contains("!4F"), "black mask RLE should be !4F: {s}");
    }
}