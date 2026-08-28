import type { Socket } from 'socket.io-client';
import type { RemotePeer, MediaState } from '../types';

export interface PeerCallbacks {
  onStream: (socketId: string, stream: MediaStream) => void;
  onRemoteMediaState: (socketId: string, state: MediaState) => void;
  /** E2E chat received over a WebRTC datachannel (not relayed by the server). */
  onChat: (socketId: string, text: string, ts: number) => void;
}

type TrackKind = 'audio' | 'video';

export interface PeerStat {
  id: string;
  rttMs: number | null;
  lossPct: number;
  jitterMs: number | null;
  bitrateInKbps: number;
  bitrateOutKbps: number;
  codec: string | null;
  /** ICE path: host | srflx | prflx | relay | unknown (relay = TURN in use). */
  relay: string;
  /** Received audio level (0..1) for active-speaker detection. */
  audioLevel: number;
}

const CHAT_LABEL = 'uplink-chat';

export class PeerConnectionManager {
  private peers = new Map<string, RTCPeerConnection>();
  private senders = new Map<string, Map<TrackKind, RTCRtpSender>>();
  private datachannels = new Map<string, RTCDataChannel>();
  // Previous byte counters per peer, to derive bitrate from getStats() deltas.
  private prevStats = new Map<string, { t: number; bytesIn: number; bytesOut: number }>();
  maxVideoBitrate = 2_500_000;
  private socket: Socket;
  private cb: PeerCallbacks;
  private localStream: MediaStream;
  private rtcConfig: RTCConfiguration;

  constructor(socket: Socket, cb: PeerCallbacks, localStream: MediaStream, rtcConfig: RTCConfiguration) {
    this.socket = socket;
    this.cb = cb;
    this.localStream = localStream;
    this.rtcConfig = rtcConfig;
  }

  handleNewPeer(peerSocketId: string): void {
    if (this.peers.has(peerSocketId)) return;
    const pc = this.createPeer(peerSocketId);
    // Offerer creates the chat datachannel; the answerer receives it via
    // pc.ondatachannel (set in createPeer). Must be created before the offer
    // so it's included in the SDP.
    this.setupDataChannel(peerSocketId, pc.createDataChannel(CHAT_LABEL));
    setTimeout(() => {
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => {
          this.socket.emit('offer', { to: peerSocketId, offer: pc.localDescription! });
        })
        .catch((err) => console.error('[rtc] offer failed', err));
    }, 50);
  }

  async handleOffer(from: string, offer: RTCSessionDescriptionInit): Promise<void> {
    const pc = this.peers.get(from) ?? this.createPeer(from);
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.socket.emit('answer', { to: from, answer });
  }

  async handleAnswer(from: string, answer: RTCSessionDescriptionInit): Promise<void> {
    const pc = this.peers.get(from);
    if (!pc || pc.signalingState === 'stable') return;
    await pc.setRemoteDescription(answer);
  }

  async handleIceCandidate(from: string, candidate: RTCIceCandidateInit): Promise<void> {
    const pc = this.peers.get(from);
    if (!pc) return;
    try {
      await pc.addIceCandidate(candidate);
    } catch (err) {
      console.warn('[rtc] ice candidate error', err);
    }
  }

  handlePeerDisconnected(socketId: string): void {
    const pc = this.peers.get(socketId);
    if (pc) {
      pc.close();
      this.peers.delete(socketId);
      this.senders.delete(socketId);
    }
    const dc = this.datachannels.get(socketId);
    if (dc) {
      dc.close();
      this.datachannels.delete(socketId);
    }
    this.prevStats.delete(socketId);
  }

  broadcastLocalMediaState(state: MediaState): void {
    for (const pc of this.peers.keys()) {
      this.socket.emit('media-state', { to: pc, state });
    }
  }

  updateTrack(stream: MediaStream): void {
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) return;
    for (const [peerSocketId, pc] of this.peers) {
      const peerSenders = this.senders.get(peerSocketId)!;
      const sender = peerSenders.get('video');
      if (sender) {
        void sender.replaceTrack(videoTrack);
      } else {
        const newSender = pc.addTrack(videoTrack, stream);
        peerSenders.set('video', newSender);
        void this.renegotiate(peerSocketId, pc);
      }
    }
  }

  replaceLocalTrack(kind: TrackKind, track: MediaStreamTrack | null): void {
    for (const [peerSocketId, pc] of this.peers) {
      const peerSenders = this.senders.get(peerSocketId)!;
      const sender = peerSenders.get(kind);
      if (sender) {
        void sender.replaceTrack(track);
      } else if (track) {
        // Peer was created while this device was muted, so no sender exists.
        // Add the track and renegotiate so the remote side receives it.
        const newSender = pc.addTrack(track, this.localStream);
        peerSenders.set(kind, newSender);
        void this.renegotiate(peerSocketId, pc);
      }
    }
  }

  replaceRemoteVideoTrack(peerSocketId: string, track: MediaStreamTrack | null): void {
    const pc = this.peers.get(peerSocketId);
    if (!pc) return;
    const sender = this.senders.get(peerSocketId)?.get('video');
    if (sender) void sender.replaceTrack(track);
  }

  /**
   * Send chat over open datachannels (DTLS-encrypted, never relayed by the
   * server). Returns true if at least one peer received it; the caller falls
   * back to the signaling socket when nobody is connected yet.
   */
  sendChat(text: string): boolean {
    const ts = Date.now();
    const payload = JSON.stringify({ text, ts });
    let sent = false;
    for (const dc of this.datachannels.values()) {
      if (dc.readyState === 'open') {
        try {
          dc.send(payload);
          sent = true;
        } catch {
          // drop silently; the socket fallback covers this on the next send
        }
      }
    }
    return sent;
  }

  /**
   * Per-peer network diagnostics from getStats(): RTT, packet loss, jitter,
   * inbound/outbound bitrate, codec, and the ICE path (host/srflx/relay).
   * Bitrate is derived from byte deltas between calls.
   */
  async getPeerStats(): Promise<PeerStat[]> {
    const now =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    const out: PeerStat[] = [];

    for (const [id, pc] of this.peers) {
      try {
        const stats = await pc.getStats();
        let rtt: number | null = null;
        let relay = 'unknown';
        let packetsReceived = 0;
        let packetsLost = 0;
        let jitter: number | null = null;
        let bytesIn = 0;
        let bytesOut = 0;
        let codec: string | null = null;
        let audioLevel = 0;

        // Selected candidate pair → RTT + local candidate type (ICE path).
        let selected: any = null;
        stats.forEach((r) => {
          if (r.type !== 'candidate-pair') return;
          const p = r as RTCStats & { currentRoundTripTime?: number; nominated?: boolean };
          if (typeof p.currentRoundTripTime !== 'number') return;
          if (!selected || p.nominated) selected = p;
        });
        if (selected) {
          if (typeof selected.currentRoundTripTime === 'number') {
            rtt = selected.currentRoundTripTime * 1000;
          }
          const local = stats.get(selected.localCandidateId) as
            | (RTCStats & { candidateType?: string })
            | undefined;
          if (local?.candidateType) relay = local.candidateType;
        }

        stats.forEach((r) => {
          if (r.type === 'inbound-rtp') {
            const ir = r as RTCStats & {
              packetsReceived?: number;
              packetsLost?: number;
              jitter?: number;
              bytesReceived?: number;
              codecId?: string;
              kind?: string;
              audioLevel?: number;
            };
            packetsReceived += ir.packetsReceived ?? 0;
            packetsLost += ir.packetsLost ?? 0;
            if (typeof ir.jitter === 'number') jitter = ir.jitter * 1000;
            bytesIn += ir.bytesReceived ?? 0;
            if (ir.kind === "audio" && typeof ir.audioLevel === "number") {
              audioLevel = Math.max(audioLevel, ir.audioLevel);
            }
            if (!codec && ir.codecId) {
              const c = stats.get(ir.codecId) as (RTCStats & { mimeType?: string }) | undefined;
              if (c?.mimeType) codec = c.mimeType.split('/')[1] ?? null;
            }
          } else if (r.type === 'outbound-rtp') {
            const or = r as RTCStats & { bytesSent?: number };
            bytesOut += or.bytesSent ?? 0;
          }
        });

        // Bitrate from byte deltas vs the previous sample.
        const prev = this.prevStats.get(id);
        let bitrateIn = 0;
        let bitrateOut = 0;
        if (prev) {
          const dt = (now - prev.t) / 1000;
          if (dt > 0) {
            bitrateIn = Math.max(0, ((bytesIn - prev.bytesIn) * 8) / dt / 1000);
            bitrateOut = Math.max(0, ((bytesOut - prev.bytesOut) * 8) / dt / 1000);
          }
        }
        this.prevStats.set(id, { t: now, bytesIn, bytesOut });

        const denom = packetsReceived + packetsLost;
        out.push({
          id,
          rttMs: rtt === null ? null : Math.round(rtt),
          lossPct: denom > 0 ? Math.round((packetsLost / denom) * 1000) / 10 : 0,
          jitterMs: jitter === null ? null : Math.round(jitter),
          bitrateInKbps: Math.round(bitrateIn),
          bitrateOutKbps: Math.round(bitrateOut),
          codec,
          relay,
          audioLevel,
        });
      } catch {
        // skip a failing peer connection
      }
    }
    return out;
  }

  closeAll(): void {
    for (const pc of this.peers.values()) pc.close();
    for (const dc of this.datachannels.values()) dc.close();
    this.peers.clear();
    this.senders.clear();
    this.datachannels.clear();
    this.prevStats.clear();
  }

  getPeerCount(): number {
    return this.peers.size;
  }

  private setupDataChannel(peerSocketId: string, dc: RTCDataChannel): void {
    dc.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as { text?: string; ts?: number };
        if (typeof msg.text === 'string') {
          this.cb.onChat(peerSocketId, msg.text, msg.ts ?? Date.now());
        }
      } catch {
        // ignore malformed payloads
      }
    };
    dc.onclose = () => {
      this.datachannels.delete(peerSocketId);
    };
    this.datachannels.set(peerSocketId, dc);
  }

  private async renegotiate(peerSocketId: string, pc: RTCPeerConnection): Promise<void> {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.socket.emit('offer', { to: peerSocketId, offer: pc.localDescription! });
    } catch (err) {
      console.error('[rtc] renegotiate failed', err);
    }
  }

  private createPeer(peerSocketId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection(this.rtcConfig);
    const peerSenders = new Map<TrackKind, RTCRtpSender>();
    this.senders.set(peerSocketId, peerSenders);

    for (const track of this.localStream.getTracks()) {
      if (track.readyState !== 'live') continue;
      const sender = pc.addTrack(track, this.localStream);
      if (track.kind === 'video') {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
        params.encodings[0].maxBitrate = this.maxVideoBitrate;
        void sender.setParameters(params);
      }
      peerSenders.set(track.kind as TrackKind, sender);
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('ice-candidate', { to: peerSocketId, candidate: event.candidate.toJSON() });
      }
    };

    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (stream) this.cb.onStream(peerSocketId, stream);
    };

    // Answerer side: receive the offerer's chat datachannel.
    pc.ondatachannel = (event) => {
      this.setupDataChannel(peerSocketId, event.channel);
    };

    this.peers.set(peerSocketId, pc);
    return pc;
  }
}

export type { RemotePeer };