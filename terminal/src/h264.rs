//! H.264 (RFC 6184) RTP depacketizer.
//!
//! Assembles RTP payloads into Annex-B access units for openh264:
//!   * single NAL units (types 1–23)
//!   * STAP-A aggregation packets (type 24)
//!   * FU-A fragmentation (type 28) with start/end bits
//!
//! SPS/PPS (types 7/8) are cached and prepended to IDR frames, so openh264
//! always sees a decodable access unit even if it joined mid-stream.

const START: [u8; 3] = [0x00, 0x00, 0x01];

#[derive(Default, Debug, Clone)]
pub struct H264Depacketizer {
    /// Reconstructed fragment buffer for an in-progress FU-A.
    frag: Vec<u8>,
    frag_active: bool,
    sps: Option<Vec<u8>>,
    pps: Option<Vec<u8>>,
}

impl H264Depacketizer {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one RTP H264 payload. Returns an Annex-B access unit when a frame
    /// is complete (None while still assembling a fragmented NAL).
    #[must_use]
    pub fn feed(&mut self, payload: &[u8]) -> Option<Vec<u8>> {
        if payload.is_empty() {
            return None;
        }
        let header = payload[0];
        let nal_type = header & 0x1f;
        match nal_type {
            1..=23 => self.single_nal(payload, nal_type),
            24 => self.stap_a(&payload[1..]),
            28 => self.fu_a(payload),
            // STAP-B / MTAP16 / MTAP24 aren't used by browsers in practice.
            _ => None,
        }
    }

    fn single_nal(&mut self, nal: &[u8], nal_type: u8) -> Option<Vec<u8>> {
        if nal.is_empty() {
            return None;
        }
        match nal_type {
            7 => {
                // SPS — cache, emit as a standalone "unit" so the decoder
                // sees parameter changes too (cheap: openh264 ignores
                // repeats of identical sets).
                self.sps = Some(nal.to_vec());
                Some(nal_with_start(nal))
            }
            8 => {
                self.pps = Some(nal.to_vec());
                Some(nal_with_start(nal))
            }
            5 => {
                // IDR: prepend cached parameter sets so decoding works
                // whenever the access unit opens the stream.
                let mut out = Vec::with_capacity(nal.len() + 32);
                if let Some(sps) = &self.sps {
                    out.extend_from_slice(&START);
                    out.extend_from_slice(sps);
                }
                if let Some(pps) = &self.pps {
                    out.extend_from_slice(&START);
                    out.extend_from_slice(pps);
                }
                out.extend_from_slice(&START);
                out.extend_from_slice(nal);
                Some(out)
            }
            _ => Some(nal_with_start(nal)),
        }
    }

    /// STAP-A: one packet carrying several NAL units, each prefixed by a
    /// 2-byte size.
    fn stap_a(&mut self, rest: &[u8]) -> Option<Vec<u8>> {
        let mut out = Vec::with_capacity(rest.len() + 12);
        let mut off = 0usize;
        while off + 2 <= rest.len() {
            let size = ((rest[off] as usize) << 8) | rest[off + 1] as usize;
            off += 2;
            if size == 0 || off + size > rest.len() {
                break;
            }
            let nal = &rest[off..off + size];
            match nal[0] & 0x1f {
                7 => {
                    self.sps = Some(nal.to_vec());
                    out.extend_from_slice(&START);
                    out.extend_from_slice(nal);
                }
                8 => {
                    self.pps = Some(nal.to_vec());
                    out.extend_from_slice(&START);
                    out.extend_from_slice(nal);
                }
                _ => {
                    out.extend_from_slice(&START);
                    out.extend_from_slice(nal);
                }
            }
            off += size;
        }
        if out.is_empty() { None } else { Some(out) }
    }

    /// FU-A fragmentation: reconstruct the full NAL, then wrap it as AU.
    fn fu_a(&mut self, payload: &[u8]) -> Option<Vec<u8>> {
        if payload.len() < 2 {
            return None;
        }
        let indicator = payload[0];
        let header = payload[1];
        let start = header & 0x80 != 0;
        let end = header & 0x40 != 0;
        let fu_type = header & 0x1f;
        let body = &payload[2..];

        if start {
            self.frag.clear();
            // Reconstructed NAL header: F+NRI from indicator, type from FU header.
            self.frag.push((indicator & 0xE0) | fu_type);
            self.frag_active = true;
        }
        if !self.frag_active {
            return None;
        }
        self.frag.extend_from_slice(body);

        if end {
            self.frag_active = false;
            let nal = std::mem::take(&mut self.frag);
            let mut out = Vec::with_capacity(nal.len() + 40);
            if fu_type == 5 {
                if let Some(sps) = &self.sps {
                    out.extend_from_slice(&START);
                    out.extend_from_slice(sps);
                }
                if let Some(pps) = &self.pps {
                    out.extend_from_slice(&START);
                    out.extend_from_slice(pps);
                }
            }
            out.extend_from_slice(&START);
            out.extend_from_slice(&nal);
            return Some(out);
        }
        None
    }
}

fn nal_with_start(nal: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(nal.len() + START.len());
    v.extend_from_slice(&START);
    v.extend_from_slice(nal);
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_nal_passes_through() {
        let mut d = H264Depacketizer::new();
        // Non-IDR slice, type 1, NRI 2
        let au = d.feed(&[0x41, 0x11, 0x22]).expect("AU");
        assert_eq!(au, vec![0, 0, 1, 0x41, 0x11, 0x22]);
    }

    #[test]
    fn stap_a_splits_nals() {
        let mut d = H264Depacketizer::new();
        // STAP-A header 0x78; two NALs (type 1, type 5)
        let mut p = vec![0x78];
        p.extend_from_slice(&[0x00, 0x03, 0x41, 0x11, 0x22]);
        p.extend_from_slice(&[0x00, 0x03, 0x65, 0x33, 0x44]);
        let au = d.feed(&p).expect("AU");
        assert_eq!(
            au,
            vec![0, 0, 1, 0x41, 0x11, 0x22, 0, 0, 1, 0x65, 0x33, 0x44]
        );
    }

    #[test]
    fn fu_a_reassembles_with_sps_pps() {
        let sc = [0, 0, 1];
        let mut d = H264Depacketizer::new();
        // Cache SPS + PPS (their own standalone AUs are emitted too)
        let _ = d.feed(&[0x67, 0x42]);
        let _ = d.feed(&[0x68, 0x42]);
        // FU-A fragmented IDR: start / continuation+end. NAL 0x65, payload AA BB CC.
        assert!(d.feed(&[0x7c, 0x85, 0xAA, 0xBB]).is_none());
        let au = d.feed(&[0x7c, 0x45, 0xCC]).expect("reconstructed IDR");
        let expected: Vec<u8> = [
            sc.as_slice(),
            &[0x67, 0x42],
            sc.as_slice(),
            &[0x68, 0x42],
            sc.as_slice(),
            &[0x65, 0xAA, 0xBB, 0xCC],
        ]
        .concat();
        assert_eq!(au, expected);
    }

    #[test]
    fn incomplete_fu_is_silent() {
        let mut d = H264Depacketizer::new();
        // FU-A start but no end: no AU should be produced
        assert!(d.feed(&[0x7c, 0x85, 0x12, 0x34]).is_none());
        // STAP-A with garbage size reads zero NALs
        assert!(d.feed(&[0x78, 0x00, 0x00]).is_none());
        // Empty payload
        assert!(d.feed(&[]).is_none());
    }
}
