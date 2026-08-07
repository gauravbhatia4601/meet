import type { Socket } from 'socket.io-client';
import type { RemotePeer, MediaState } from '../types';

export interface PeerCallbacks {
  onStream: (socketId: string, stream: MediaStream) => void;
  onRemoteMediaState: (socketId: string, state: MediaState) => void;
}

type TrackKind = 'audio' | 'video';

export class PeerConnectionManager {
  private peers = new Map<string, RTCPeerConnection>();
  // Per-peer, per-kind sender index. We keep this because the old lookup
  // `pc.getSenders().find(s => s.track?.kind === kind)` stops working the
  // moment a track is replaced with null (mute) — s.track becomes null and the
  // sender can never be found again, so re-enabling a device silently failed
  // to reach remote peers. Indexing senders ourselves keeps them findable
  // regardless of whether their current track is null.
  private senders = new Map<string, Map<TrackKind, RTCRtpSender>>();
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

  closeAll(): void {
    for (const pc of this.peers.values()) pc.close();
    this.peers.clear();
    this.senders.clear();
  }

  getPeerCount(): number {
    return this.peers.size;
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

    this.peers.set(peerSocketId, pc);
    return pc;
  }
}

export type { RemotePeer };
