import type { Socket } from 'socket.io-client';
import type { RemotePeer, MediaState } from '../types';

export interface PeerCallbacks {
  onStream: (socketId: string, stream: MediaStream) => void;
  onRemoteMediaState: (socketId: string, state: MediaState) => void;
}

export class PeerConnectionManager {
  private peers = new Map<string, RTCPeerConnection>();
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

  /**
   * Called when a remote peer announces itself (they just joined). We create
   * a connection and send an offer.
   */
  handleNewPeer(peerSocketId: string): void {
    if (this.peers.has(peerSocketId)) return;
    const pc = this.createPeer(peerSocketId);
    // Give ICE time to gather before sending the offer.
    setTimeout(() => {
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => {
          this.socket.emit('offer', { to: peerSocketId, offer: pc.localDescription! });
        })
        .catch((err) => console.error('[rtc] offer failed', err));
    }, 50);
  }

  /** Handle an incoming offer from a remote peer. */
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
      // Candidates arriving after the remote description is set are expected.
      console.warn('[rtc] ice candidate error', err);
    }
  }

  handlePeerDisconnected(socketId: string): void {
    const pc = this.peers.get(socketId);
    if (pc) {
      pc.close();
      this.peers.delete(socketId);
    }
  }

  /** Apply the current local media state to every peer connection. */
  broadcastLocalMediaState(state: MediaState): void {
    const payload = { to: '', state };
    for (const pc of this.peers.keys()) {
      this.socket.emit('media-state', { ...payload, to: pc });
    }
  }

  updateTrack(stream: MediaStream): void {
    for (const pc of this.peers.values()) {
      const videoTrack = stream.getVideoTracks()[0];
      const sender = pc
        .getSenders()
        .find((s) => s.track?.kind === 'video');
      if (sender && videoTrack) {
        void sender.replaceTrack(videoTrack);
      }
    }
  }

  /**
   * Replace a local track of the given kind across all peers.
   * Passing `null` stops sending that kind (used when a device is released).
   */
  replaceLocalTrack(kind: 'audio' | 'video', track: MediaStreamTrack | null): void {
    for (const pc of this.peers.values()) {
      const sender = pc.getSenders().find((s) => s.track?.kind === kind);
      if (sender) {
        void sender.replaceTrack(track);
      }
    }
  }

  /** Replace a remote peer's video track (for camera/screen switching). */
  replaceRemoteVideoTrack(peerSocketId: string, track: MediaStreamTrack | null): void {
    const pc = this.peers.get(peerSocketId);
    if (!pc) return;
    const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
    if (sender) {
      void sender.replaceTrack(track);
    }
  }

  closeAll(): void {
    for (const pc of this.peers.values()) pc.close();
    this.peers.clear();
  }

  getPeerCount(): number {
    return this.peers.size;
  }

  private createPeer(peerSocketId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection(this.rtcConfig);

    // Add all live local tracks so the remote side receives them. Stopped
    // tracks (a muted camera/mic that was released) are skipped so late-joining
    // peers don't get dead tracks.
    for (const track of this.localStream.getTracks()) {
      if (track.readyState !== 'live') continue;
      pc.addTrack(track, this.localStream);
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
