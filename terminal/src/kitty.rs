// Kitty graphics protocol encoder — raw RGB + zlib + chunked base64.
//
// Why kitty (instead of OSC-1337 inline images):
//   * iTerm2 stores inline images per-draw and *leaks* them (gitlab #10420),
//     so frame-by-frame inline animation grows without bound.
//   * The kitty protocol replaces image data by ID: re-transmitting with the
//     same `i=` frees the previous frame inside the terminal, which also caps
//     retained images with an LRU (320MB in iTerm2). Memory stays flat.
//
// Each frame = single APC sequence with raw f=24 RGB (no compression by
// default — matches the byte patterns verified working against iTerm2
// 3.6.11), chunked at 4096 base64 chars, replacing image id=1.
//
// CHUNKING RULE (this bit cost us a day): the frame containing the FINAL
// slice of base64 MUST carry m=0. A frame that says m=1 tells the terminal
// "more chunks follow"; if none ever come, kitty terminals WAIT FOREVER —
// no image, no ACK, no error (iTerm2: "more=expectMore, not sending
// response"). So for single-chunk payloads the header itself is the final
// chunk and must say m=0.

use base64::Engine as _;
use flate2::{Compress, Compression, FlushCompress};

pub struct KittyEnc {
    zlib: Compress,
    zbuf: Vec<u8>,
    b64: Vec<u8>,
    header_cache: String,
    /// 1 = suppress success ACKs but SHOW errors (default — silent on the
    /// happy path, loud on failure). 0 = everything visible (UPLINK_KITTY_DEBUG=1).
    /// 2 = fully silent including errors (avoid: hides failures).
    pub quiet: u8,
    /// Image id used for frames. Fixed id → terminal replaces in place
    /// (memory-flat animation). The self-test matrix uses unique ids so each
    /// variant renders independently.
    pub img_id: u32,
    /// Placement id in the draw command. 0 = omit (transient placements). For
    /// animation this MUST be non-zero: iTerm2 de-dupes placements by explicit
    /// placement id; with p omitted every frame APPENDS another stacked
    /// placement of the same image and the renderer drowns in overlap.
    pub placement_id: u32,
    /// true = zlib-compress the frame (`o=z`). Raw f=24 is faster to encode
    /// and is the exact shape proven working in iTerm2; keep this off unless
    /// PTY bandwidth becomes the bottleneck.
    pub compress: bool,
}

impl KittyEnc {
    pub fn new() -> Self {
        KittyEnc {
            zlib: Compress::new(Compression::fast(), true),
            zbuf: Vec::with_capacity(1 << 20),
            b64: Vec::with_capacity((1 << 20) / 3 * 4),
            header_cache: String::new(),
            quiet: 1,
            img_id: 1,
            placement_id: 0,
            compress: false,
        }
    }

    /// Set response verbosity: 1 = failures only (default), 0 = verbose, 2 = silent.
    pub fn set_quiet(&mut self, q: u8) {
        self.quiet = q;
    }

    /// Compress + base64 + chunk-emit one frame into `out` (reused buffer).
    /// Placement: same image id (1) and placement id (1) every frame →
    /// iTerm2/kitty replace in place: no flicker, no accumulation.
    pub fn encode_into(
        &mut self,
        rgb: &[u8],
        w: usize,
        h: usize,
        cols: usize,
        rows: usize,
        out: &mut Vec<u8>,
    ) {
        out.clear();

        // ── payload bytes: zlib-compress (optional) the raw RGB frame ──────
        self.zbuf.clear();
        if self.compress {
            self.zlib.reset();
            // Guarantee capacity: compressed output can slightly exceed input
            // for incompressible data. compress_vec only writes into spare
            // capacity, so short-capacity would silently drop the tail.
            self.zbuf.reserve(rgb.len() + rgb.len() / 16 + 128);
            let _ = self
                .zlib
                .compress_vec(rgb, &mut self.zbuf, FlushCompress::Finish);
        } else {
            self.zbuf.extend_from_slice(rgb);
        }

        // ── base64 into reused buffer ───────────────────────────────────────
        self.b64.clear();
        let need = self.zbuf.len().div_ceil(3) * 4;
        self.b64.resize(need, 0);
        let b64_len = base64::engine::general_purpose::STANDARD
            .encode_slice(&self.zbuf, &mut self.b64)
            .unwrap_or(0);

        // ── chunked emit. EVERY chunk is its own complete APC: `ESC _ G …
        // ESC \`. A continuation chunk is `ESC _ G m=1;<slice> ESC \` — the
        // ST terminator must appear after EACH chunk, not once at the end:
        // inside an APC, `ESC _` is just payload, so one shared ST would merge
        // all chunks into a single undecodable blob. The final chunk says
        // m=0; earlier ones m=1. For a single-chunk payload the header chunk
        // is also the final chunk (header says m=0).
        let b = &self.b64[..b64_len];
        let total_chunks = b64_len.div_ceil(4096).max(1);
        let mut off = 0usize;
        let mut emitted = 0usize;
        loop {
            let end = (off + 4096).min(b.len());
            let m: u8 = if emitted + 1 == total_chunks && end == b.len() {
                0
            } else {
                1
            };
            if emitted == 0 {
                self.header_cache.clear();
                self.header_cache.push_str("\x1b_Ga=T,f=24,s=");
                self.header_cache.push_str(&w.to_string());
                self.header_cache.push_str(",v=");
                self.header_cache.push_str(&h.to_string());
                if self.compress {
                    self.header_cache.push_str(",o=z");
                }
                self.header_cache.push_str(",i=");
                self.header_cache.push_str(&self.img_id.to_string());
                if self.placement_id != 0 {
                    self.header_cache
                        .push_str(&format!(",p={}", self.placement_id));
                }
                self.header_cache.push_str(",q=");
                self.header_cache.push_str(&self.quiet.to_string());
                self.header_cache.push_str(",c=");
                self.header_cache.push_str(&cols.to_string());
                self.header_cache.push_str(",r=");
                self.header_cache.push_str(&rows.to_string());
                self.header_cache.push_str(",C=1");
                self.header_cache.push_str(",m=");
                self.header_cache.push(char::from(b'0' + m));
                self.header_cache.push(';');
                out.extend_from_slice(self.header_cache.as_bytes());
            } else {
                out.extend_from_slice(b"\x1b_Gm=");
                out.push(b'0' + m);
                out.push(b';');
            }
            out.extend_from_slice(&b[off..end]);
            out.extend_from_slice(b"\x1b\\"); // every chunk terminates its own APC
            off = end;
            emitted += 1;
            if end >= b.len() {
                break;
            }
        }
    }
}

impl Default for KittyEnc {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_kitty_structure_single_chunk_is_m0() {
        let w = 8;
        let h = 4;
        let rgb = vec![128u8; w * h * 3]; // 96 bytes → 128 b64 chars → ONE chunk
        let mut out = Vec::new();
        KittyEnc::new().encode_into(&rgb, w, h, 10, 5, &mut out);
        let s = String::from_utf8_lossy(&out);
        assert!(s.starts_with("\x1b_Ga=T,f=24,s=8,v=4,"), "header: {s}");
        assert!(!s.contains("o=z"), "must NOT compress by default (proven path)");
        assert!(s.contains("i=1"), "fixed image id for in-place replace");
        assert!(s.contains("q=1"), "default suppresses success ACKs but shows errors");
        assert!(s.contains("c=10") || s.contains("r=5"), "cell box sizing");
        assert!(s.contains(",C=1,"), "doNotMoveCursor prevents cursor-driven scroll");
        // THE FIX: single-chunk frame's header must be the FINAL chunk → m=0.
        // m=1 with no continuation makes terminals wait for chunks forever.
        assert!(s.contains(",m=0;"), "single-chunk header must end m=0: {s}");
        assert!(!s.contains(",m=1;"), "m=1 would orphan the frame: {s}");
        assert!(s.ends_with("\x1b\\"), "must end with ST");
    }

    #[test]
    fn test_kitty_placement_for_animation() {
        // Repeated video frames must carry p=1 so the terminal REPLACES the
        // placement; without it, iTerm2 stacks a new placement every frame.
        let rgb = vec![10u8; 8 * 4 * 3];
        let mut enc = KittyEnc::new();
        enc.placement_id = 1;
        let mut out = Vec::new();
        enc.encode_into(&rgb, 8, 4, 10, 5, &mut out);
        let s = String::from_utf8_lossy(&out);
        assert!(s.contains(",p=1,"), "video frames need explicit placement id: {s}");

        // Default (0) must omit p entirely — legacy/test behavior.
        let mut out2 = Vec::new();
        KittyEnc::new().encode_into(&rgb, 8, 4, 10, 5, &mut out2);
        let s2 = String::from_utf8_lossy(&out2);
        assert!(!s2.contains(",p="), "default omits placement id");
    }

    #[test]
    fn test_kitty_compressed_flag() {
        let w = 8;
        let h = 4;
        let rgb = vec![128u8; w * h * 3];
        let mut enc = KittyEnc::new();
        enc.compress = true;
        let mut out = Vec::new();
        enc.encode_into(&rgb, w, h, 10, 5, &mut out);
        let s = String::from_utf8_lossy(&out);
        assert!(s.contains("o=z"), "compressed frames must advertise o=z: {s}");
        assert!(s.contains(",m=0;"), "single chunk still ends m=0");
    }

    #[test]
    fn test_kitty_chained_chunks() {
        // Incompressible pseudo-random frame → zlib keeps ~raw size →
        // forces multiple 4096-byte chunks with continuation markers.
        let w = 128;
        let h = 128;
        let mut x = 0x9E37_79B9u32;
        let rgb: Vec<u8> = (0..w * h * 3)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                x as u8
            })
            .collect();
        let mut enc = KittyEnc::new();
        enc.quiet = 2; // multi-m assertions below key on q=2 continuations
        let mut out = Vec::new();
        enc.encode_into(&rgb, w, h, 40, 20, &mut out);
        let s = String::from_utf8_lossy(&out);
        // Continuation frames carry ONLY the m key (proven working shape).
        let continuations = s.matches("\x1b_Gm=1;").count();
        let final_zero = s.matches("\x1b_Gm=0;").count();
        assert!(continuations >= 2, "expected ≥2 continuation chunks, got {continuations}");
        // Header chunk (m=1) + exactly one m=0 final continuation.
        assert_eq!(final_zero, 1, "exactly one m=0 final chunk required");
        assert!(s.contains(",m=1;"), "header chunk must say m=1 (more follow)");
        // FRAMING INVARIANT: every chunk is its own complete APC — one ST per
        // ESC_G. Without per-chunk ST the chunks merge into one undecodable APC.
        let apcs = s.matches("\x1b_G").count();
        let sts = s.matches("\x1b\\").count();
        assert_eq!(apcs, sts, "every chunk needs its own ESC\\ terminator (found {apcs} APCs, {sts} STs): {s}");
        assert!(s.ends_with("\x1b\\"));
    }

    #[test]
    fn test_kitty_roundtrip_payload() {
        // Payload between header ';' and ST must decode back to the raw RGB
        // bytes (no compression by default). Uses a multi-chunk frame to also
        // verify chunk concatenation reproduces the exact byte stream.
        let w = 64;
        let h = 64; // 12288 bytes → >4096 b64 chars → multi-chunk
        let rgb: Vec<u8> = (0..w * h * 3).map(|i| (i % 200) as u8).collect();
        let mut out = Vec::new();
        KittyEnc::new().encode_into(&rgb, w, h, 30, 30, &mut out);
        let s = String::from_utf8_lossy(&out);
        // Concatenate every payload slice: frame bodies are the text between
        // ';' and the next ESC.
        let mut joined = String::new();
        for frame in s.split("\x1b_G").skip(1) {
            if let Some((_, payload)) = frame.split_once(';') {
                if let Some(p) = payload.split("\x1b\\").next() {
                    joined.push_str(p);
                }
            }
        }
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(joined.trim_end_matches('\0'))
            .expect("base64 of concatenated chunks decodes");
        assert_eq!(decoded.len(), w * h * 3, "payload is exact raw RGB");
        assert_eq!(decoded, rgb, "roundtrip bytes match");
    }
}