/**
 * PeerConnectionManager
 * 
 * Manages WebRTC peer connections for all participants
 * Handles:
 * - Creating/destroying peer connections
 * - Offer/answer exchange (via SignalingClient)
 * - ICE candidate handling
 * - Media stream attachment
 * - Connection state tracking
 * 
 * This is the NEXT dependency - uses SignalingClient
 */

import { getRTCConfiguration } from '../../config/iceServers.js';
import { signalingClient } from '../signaling/index.js';
import { mediaStreamManager } from '../media/MediaStreamManager.js';
import type {
  WebRTCOfferData,
  WebRTCAnswerData,
  WebRTCIceCandidateData
} from '../signaling/signalingEvents.js';

export interface PeerConnection {
  peerId: string;
  connection: RTCPeerConnection;
  dataChannel: RTCDataChannel | null;
  stream: MediaStream | null;
}

export interface PeerConnectionCallbacks {
  onStreamAdded?: (peerId: string, stream: MediaStream) => void;
  onStreamRemoved?: (peerId: string) => void;
  onConnectionStateChanged?: (peerId: string, state: RTCPeerConnectionState) => void;
  onIceConnectionStateChanged?: (peerId: string, state: RTCIceConnectionState) => void;
  onError?: (peerId: string, error: Error) => void;
  onDataChannelMessage?: (peerId: string, message: string) => void;
}

export class PeerConnectionManager {
  private peers: Map<string, PeerConnection> = new Map();
  private localStream: MediaStream | null = null;
  private localPeerId: string = '';
  private callbacks: PeerConnectionCallbacks = {};
  private isInitialized = false;
  private streamUnsubscribe: (() => void) | null = null;

  /**
   * Initialize the manager
   * 
   * CRITICAL: This subscribes to MediaStreamManager to automatically
   * get stream updates. Media streaming is now completely independent
   * of component lifecycle.
   * 
   * Can be called multiple times - if peerId changes, it will reinitialize.
   */
  initialize(localPeerId: string): void {
    // If already initialized with same peerId, do nothing
    if (this.isInitialized && this.localPeerId === localPeerId) {
      console.log(`[PeerConnectionManager] Already initialized with peerId: ${localPeerId}`);
      return;
    }

    // If peerId changed (user rejoined), clean up old state
    if (this.isInitialized && this.localPeerId !== localPeerId) {
      console.log(`[PeerConnectionManager] PeerId changed from ${this.localPeerId} to ${localPeerId}, reinitializing...`);
      // Remove all old peer connections (they're for the old peerId)
      this.removeAllPeers();
      // Keep stream subscription active - don't unsubscribe!
      // This ensures stream continues to work when user rejoins
      console.log(`[PeerConnectionManager] Kept stream subscription active for rejoin`);
      // Reset initialization flag to allow re-setup
      this.isInitialized = false;
    }

    this.localPeerId = localPeerId;
    this.isInitialized = true;

    // Set up signaling event handlers
    signalingClient.setCallbacks({
      onWebRTCOffer: (data) => this.handleOffer(data),
      onWebRTCAnswer: (data) => this.handleAnswer(data),
      onWebRTCIceCandidate: (data) => this.handleIceCandidate(data),
      onParticipantLeft: (data) => this.removePeer(data.peerId)
    });

    // CRITICAL: Subscribe to MediaStreamManager for automatic stream updates
    // This makes media streaming completely independent of component lifecycle
    // Only subscribe if not already subscribed (preserve subscription across reinitializations)
    if (!this.streamUnsubscribe) {
      this.streamUnsubscribe = mediaStreamManager.onStreamChange((stream) => {
        console.log('[PeerConnectionManager] Stream changed via MediaStreamManager, updating all peer connections');
        this.setLocalStream(stream);
      });
      console.log('[PeerConnectionManager] Subscribed to MediaStreamManager for automatic stream updates');
    } else {
      console.log('[PeerConnectionManager] Stream subscription already active (preserved across rejoin)');
    }

    // Get current stream immediately
    const currentStream = mediaStreamManager.getStream();
    if (currentStream) {
      console.log(`[PeerConnectionManager] Current stream available: ${currentStream.getTracks().length} tracks`);
      this.setLocalStream(currentStream);
    } else {
      console.log('[PeerConnectionManager] No stream available yet - will be added automatically when available');
    }

    console.log('[PeerConnectionManager] Initialized for peer:', localPeerId);
  }

  /**
   * Set local media stream
   * 
   * CRITICAL: Automatically adds tracks to ALL existing peer connections.
   * This is called automatically when MediaStreamManager stream changes.
   * Tracks must be added BEFORE setRemoteDescription() is called.
   * If remote description is already set, we use addTransceiver() or renegotiate.
   */
  setLocalStream(stream: MediaStream | null): void {
    const streamChanged = this.localStream !== stream;
    this.localStream = stream;

    if (!stream) {
      console.log('[PeerConnectionManager] Stream cleared');
      return;
    }

    console.log(`[PeerConnectionManager] Setting local stream, ${stream.getTracks().length} tracks, ${this.peers.size} peers`);

    // Add tracks to all existing peer connections
    stream.getTracks().forEach(track => {
      this.peers.forEach((peer) => {
        this.addTrackToConnection(peer.connection, peer.peerId, track, stream);
      });
    });
  }

  /**
   * Ensure stream tracks are added to a connection
   * Helper method to add tracks safely
   */
  private ensureStreamInConnection(connection: RTCPeerConnection): void {
    if (!this.localStream) {
      const currentStream = mediaStreamManager.getStream();
      if (currentStream) {
        this.localStream = currentStream;
      } else {
        return;
      }
    }

    this.localStream.getTracks().forEach(track => {
      const sender = connection.getSenders().find(s => s.track?.kind === track.kind);
      if (!sender) {
        // No sender exists, add track
        try {
          connection.addTrack(track, this.localStream!);
          console.log(`[PeerConnectionManager] Added ${track.kind} track to connection`);
        } catch (err) {
          console.error(`[PeerConnectionManager] Failed to add ${track.kind} track:`, err);
        }
      }
    });
  }

  /**
   * Add a track to a connection, handling all edge cases
   */
  private addTrackToConnection(
    connection: RTCPeerConnection,
    peerId: string,
    track: MediaStreamTrack,
    stream: MediaStream
  ): void {
    const sender = connection.getSenders().find(s => {
      return s.track?.kind === track.kind;
    });

    if (sender) {
      // Replace existing track
      sender.replaceTrack(track).catch(err => {
        console.error(`[PeerConnectionManager] Failed to replace track for ${peerId}:`, err);
      });
      return;
    }

    // No sender exists - need to add track
    const remoteDescription = connection.remoteDescription;
    const localDescription = connection.localDescription;
    
    if (!remoteDescription && !localDescription) {
      // Safe to use addTrack() - no descriptions set yet
      console.log(`[PeerConnectionManager] Adding ${track.kind} track to ${peerId} (no descriptions set)`);
      try {
        connection.addTrack(track, stream);
      } catch (err) {
        console.error(`[PeerConnectionManager] Failed to add track to ${peerId}:`, err);
      }
    } else {
      // Descriptions already set - must use addTransceiver() or renegotiate
      console.log(`[PeerConnectionManager] Adding ${track.kind} track to ${peerId} via transceiver (descriptions already set)`);
      
      try {
        // Use addTransceiver() which works even after descriptions are set
        const transceiver = connection.addTransceiver(track, {
          direction: 'sendrecv',
          streams: [stream]
        });
        
        // If we're the initiator and have local description (offer), create new offer to renegotiate
        if (localDescription && connection.localDescription?.type === 'offer') {
          // Renegotiate asynchronously (don't await - fire and forget)
          this.renegotiateForNewTrack(peerId).catch(err => {
            console.error(`[PeerConnectionManager] Failed to renegotiate for ${peerId}:`, err);
          });
        }
        // If we're the responder and have local description (answer), we need to wait for new offer
        // The transceiver is added, but we'll need to renegotiate when we receive next offer
      } catch (err) {
        console.error(`[PeerConnectionManager] Failed to add transceiver for ${peerId}:`, err);
      }
    }
  }

  /**
   * Renegotiate connection to include newly added track
   */
  private async renegotiateForNewTrack(peerId: string): Promise<void> {
    const peer = this.peers.get(peerId);
    if (!peer) {
      console.error(`[PeerConnectionManager] Cannot renegotiate: Peer ${peerId} not found`);
      return;
    }

    try {
      console.log(`[PeerConnectionManager] Renegotiating connection for ${peerId} to include new track`);
      const offer = await peer.connection.createOffer();
      await peer.connection.setLocalDescription(offer);
      signalingClient.sendWebRTCOffer(peerId, offer);
      console.log(`[PeerConnectionManager] Sent renegotiation offer to ${peerId}`);
    } catch (err) {
      console.error(`[PeerConnectionManager] Failed to renegotiate for ${peerId}:`, err);
      throw err;
    }
  }

  /**
   * Set callbacks
   */
  setCallbacks(callbacks: PeerConnectionCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  /**
   * Add a new peer and create connection
   * 
   * CRITICAL: Automatically ensures stream exists and adds tracks.
   * Media streaming is now completely independent and automatic.
   */
  async addPeer(remotePeerId: string, isInitiator: boolean = false): Promise<RTCPeerConnection> {
    // Don't connect to self
    if (remotePeerId === this.localPeerId) {
      throw new Error('Cannot connect to self');
    }

    // Check if peer already exists
    if (this.peers.has(remotePeerId)) {
      console.log(`[PeerConnectionManager] Peer ${remotePeerId} already exists`);
      const existingPeer = this.peers.get(remotePeerId)!;
      // Ensure stream is still added to existing connection
      this.ensureStreamInConnection(existingPeer.connection);
      return existingPeer.connection;
    }

    console.log(`[PeerConnectionManager] Adding peer: ${remotePeerId} (initiator: ${isInitiator})`);

    // Create RTCPeerConnection
    const config = getRTCConfiguration();
    const connection = new RTCPeerConnection(config);

    // CRITICAL: Automatically ensure stream exists and add tracks
    // Get current stream from MediaStreamManager (independent of component state)
    let currentStream = mediaStreamManager.getStream();
    
    // If no stream in MediaStreamManager, try to get from media store as fallback
    if (!currentStream) {
      try {
        const { useMediaStore } = await import('../../store/mediaStore.js');
        const mediaState = useMediaStore.getState();
        currentStream = mediaState.localStream;
        if (currentStream) {
          console.log(`[PeerConnectionManager] Got stream from media store for ${remotePeerId}`);
          // Set it in MediaStreamManager so it's available for future peers
          mediaStreamManager.setStream(currentStream);
        }
      } catch (err) {
        console.warn(`[PeerConnectionManager] Could not access media store:`, err);
      }
    }
    
    if (currentStream) {
      console.log(`[PeerConnectionManager] Adding ${currentStream.getTracks().length} tracks from MediaStreamManager to ${remotePeerId}`);
      this.localStream = currentStream;
      currentStream.getTracks().forEach(track => {
        try {
          connection.addTrack(track, currentStream);
          console.log(`[PeerConnectionManager] ✅ Added ${track.kind} track (${track.id}) to ${remotePeerId}`);
        } catch (err) {
          console.error(`[PeerConnectionManager] ❌ Failed to add ${track.kind} track to ${remotePeerId}:`, err);
        }
      });
    } else {
      console.warn(`[PeerConnectionManager] ⚠️ No stream available when adding peer ${remotePeerId}. Stream will be added automatically when available via MediaStreamManager subscription.`);
      // Stream will be added automatically via MediaStreamManager subscription
    }

    // Set up event handlers
    this.setupConnectionHandlers(connection, remotePeerId);

    // Create data channel if initiator
    let dataChannel: RTCDataChannel | null = null;
    if (isInitiator) {
      dataChannel = connection.createDataChannel('chat', {
        ordered: true
      });
      this.setupDataChannelHandlers(dataChannel, remotePeerId);
    } else {
      // Wait for data channel from remote
      connection.ondatachannel = (event) => {
        dataChannel = event.channel;
        this.setupDataChannelHandlers(dataChannel, remotePeerId);
      };
    }

    // Store peer connection
    const peerConnection: PeerConnection = {
      peerId: remotePeerId,
      connection,
      dataChannel,
      stream: null
    };
    this.peers.set(remotePeerId, peerConnection);

    // If initiator, create and send offer
    if (isInitiator) {
      // CRITICAL: Ensure stream is available before creating offer
      // Double-check stream exists (it might have been set after connection creation)
      if (!this.localStream) {
        const stream = mediaStreamManager.getStream();
        if (stream) {
          console.log(`[PeerConnectionManager] Stream became available, adding tracks to ${remotePeerId} before creating offer`);
          this.localStream = stream;
          stream.getTracks().forEach(track => {
            try {
              connection.addTrack(track, stream);
              console.log(`[PeerConnectionManager] Added ${track.kind} track to ${remotePeerId} before offer`);
            } catch (err) {
              console.error(`[PeerConnectionManager] Failed to add ${track.kind} track:`, err);
            }
          });
        }
      }
      await this.createOffer(remotePeerId);
    }

    return connection;
  }

  /**
   * Restart ICE for a peer connection
   */
  private async restartICE(peerId: string): Promise<void> {
    const peer = this.peers.get(peerId);
    if (!peer) {
      console.warn(`[PeerConnectionManager] Cannot restart ICE: Peer ${peerId} not found`);
      return;
    }

    console.log(`[PeerConnectionManager] Restarting ICE for ${peerId}`);
    
    try {
      // Create a new offer to restart ICE
      const offer = await peer.connection.createOffer({ iceRestart: true });
      await peer.connection.setLocalDescription(offer);
      
      // Send new offer via signaling
      signalingClient.sendWebRTCOffer(peerId, offer);
      console.log(`[PeerConnectionManager] Sent ICE restart offer to ${peerId}`);
    } catch (error) {
      console.error(`[PeerConnectionManager] Failed to restart ICE for ${peerId}:`, error);
    }
  }

  /**
   * Remove a peer and cleanup
   */
  removePeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) {
      console.warn(`[PeerConnectionManager] Peer ${peerId} not found`);
      return;
    }

    console.log(`[PeerConnectionManager] Removing peer: ${peerId}`);

    // Close data channel
    if (peer.dataChannel) {
      peer.dataChannel.close();
    }

    // Close connection
    peer.connection.close();

    // Remove tracks
    if (peer.stream) {
      peer.stream.getTracks().forEach(track => track.stop());
    }

    // Remove from map
    this.peers.delete(peerId);

    // Notify callback
    this.callbacks.onStreamRemoved?.(peerId);
  }

  /**
   * Remove all peers
   */
  removeAllPeers(): void {
    const peerIds = Array.from(this.peers.keys());
    peerIds.forEach(peerId => this.removePeer(peerId));
  }

  /**
   * Get peer connection
   */
  getPeer(peerId: string): PeerConnection | undefined {
    return this.peers.get(peerId);
  }

  /**
   * Get all peer IDs
   */
  getPeerIds(): string[] {
    return Array.from(this.peers.keys());
  }

  /**
   * Send data channel message
   */
  sendMessage(peerId: string, message: string): void {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.dataChannel || peer.dataChannel.readyState !== 'open') {
      console.warn(`[PeerConnectionManager] Cannot send message to ${peerId}: data channel not ready`);
      return;
    }

    peer.dataChannel.send(message);
  }

  /**
   * Broadcast message to all peers
   */
  broadcastMessage(message: string): void {
    this.peers.forEach(peer => {
      if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
        peer.dataChannel.send(message);
      }
    });
  }

  /**
   * Create offer and send via signaling
   */
  private async createOffer(remotePeerId: string): Promise<void> {
    const peer = this.peers.get(remotePeerId);
    if (!peer) {
      throw new Error(`Peer ${remotePeerId} not found`);
    }

    try {
      const offer = await peer.connection.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      });

      await peer.connection.setLocalDescription(offer);

      // Send via signaling
      signalingClient.sendWebRTCOffer(remotePeerId, offer);
      console.log(`[PeerConnectionManager] Sent offer to ${remotePeerId}`);
    } catch (error) {
      console.error(`[PeerConnectionManager] Failed to create offer for ${remotePeerId}:`, error);
      this.callbacks.onError?.(remotePeerId, error as Error);
    }
  }

  /**
   * Handle incoming offer
   */
  private async handleOffer(data: WebRTCOfferData): Promise<void> {
    const { from, offer } = data;

    console.log(`[PeerConnectionManager] Received offer from ${from}`);

    // If peer doesn't exist, create it
    let peer = this.peers.get(from);
    if (!peer) {
      await this.addPeer(from, false);
      peer = this.peers.get(from)!;
    }

    try {
      await peer.connection.setRemoteDescription(new RTCSessionDescription(offer));

      // Create and send answer
      const answer = await peer.connection.createAnswer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      });

      await peer.connection.setLocalDescription(answer);

      // Send via signaling
      signalingClient.sendWebRTCAnswer(from, answer);
      console.log(`[PeerConnectionManager] Sent answer to ${from}`);
    } catch (error) {
      console.error(`[PeerConnectionManager] Failed to handle offer from ${from}:`, error);
      this.callbacks.onError?.(from, error as Error);
    }
  }

  /**
   * Handle incoming answer
   */
  private async handleAnswer(data: WebRTCAnswerData): Promise<void> {
    const { from, answer } = data;

    console.log(`[PeerConnectionManager] Received answer from ${from}`);

    const peer = this.peers.get(from);
    if (!peer) {
      console.error(`[PeerConnectionManager] Peer ${from} not found for answer`);
      return;
    }

    try {
      await peer.connection.setRemoteDescription(new RTCSessionDescription(answer));
      console.log(`[PeerConnectionManager] Set remote description for ${from}`);
    } catch (error) {
      console.error(`[PeerConnectionManager] Failed to handle answer from ${from}:`, error);
      this.callbacks.onError?.(from, error as Error);
    }
  }

  /**
   * Handle ICE candidate
   */
  private async handleIceCandidate(data: WebRTCIceCandidateData): Promise<void> {
    const { from, candidate } = data;

    const peer = this.peers.get(from);
    if (!peer) {
      console.error(`[PeerConnectionManager] Peer ${from} not found for ICE candidate`);
      return;
    }

    try {
      await peer.connection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      console.error(`[PeerConnectionManager] Failed to add ICE candidate from ${from}:`, error);
    }
  }

  /**
   * Setup connection event handlers
   */
  private setupConnectionHandlers(connection: RTCPeerConnection, peerId: string): void {
    // Track events
    connection.ontrack = (event) => {
      console.log(`[PeerConnectionManager] Received track from ${peerId}`);
      const stream = event.streams[0];
      if (stream) {
        const peer = this.peers.get(peerId);
        if (peer) {
          peer.stream = stream;
          this.callbacks.onStreamAdded?.(peerId, stream);
        }
      }
    };

    // ICE candidates
    connection.onicecandidate = (event) => {
      if (event.candidate) {
        const candidate = event.candidate;
        // Log candidate type for debugging
        const candidateType = candidate.type || 'unknown';
        const candidateProtocol = candidate.protocol || 'unknown';
        console.log(`[PeerConnectionManager] ${peerId} ICE candidate (${candidateType}/${candidateProtocol}):`, 
          candidate.candidate?.substring(0, 80));
        signalingClient.sendIceCandidate(peerId, candidate.toJSON());
      } else {
        console.log(`[PeerConnectionManager] ${peerId} ICE candidate gathering complete`);
      }
    };

    // ICE gathering state
    connection.onicegatheringstatechange = () => {
      const state = connection.iceGatheringState;
      console.log(`[PeerConnectionManager] ${peerId} ICE gathering state: ${state}`);
    };

    // Connection state
    connection.onconnectionstatechange = () => {
      const state = connection.connectionState;
      console.log(`[PeerConnectionManager] ${peerId} connection state: ${state}`);
      this.callbacks.onConnectionStateChanged?.(peerId, state);

      if (state === 'failed' || state === 'disconnected') {
        // Attempt to restart ICE
        if (state === 'failed') {
          console.error(`[PeerConnectionManager] Connection failed for ${peerId}, attempting restart...`);
          this.restartICE(peerId);
        }
      }
    };

    // ICE connection state
    connection.oniceconnectionstatechange = () => {
      const state = connection.iceConnectionState;
      console.log(`[PeerConnectionManager] ${peerId} ICE connection state: ${state}`);
      this.callbacks.onIceConnectionStateChanged?.(peerId, state);

      if (state === 'failed') {
        console.error(`[PeerConnectionManager] ICE connection failed for ${peerId}`);
        console.error(`[PeerConnectionManager] This usually indicates NAT traversal issues. Check TURN server configuration.`);
        
        // Log current ICE candidates for debugging
        connection.getStats().then(stats => {
          let candidateCount = 0;
          stats.forEach(report => {
            if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
              candidateCount++;
              console.log(`[PeerConnectionManager] ${report.type}:`, {
                candidateType: report.candidateType,
                protocol: report.protocol,
                address: report.address
              });
            }
          });
          console.log(`[PeerConnectionManager] Total ICE candidates collected: ${candidateCount}`);
        }).catch(err => {
          console.error(`[PeerConnectionManager] Failed to get stats:`, err);
        });
        
        this.callbacks.onError?.(peerId, new Error('ICE connection failed'));
      } else if (state === 'connected' || state === 'completed') {
        console.log(`[PeerConnectionManager] ✅ ICE connection established for ${peerId}`);
      }
    };

    // Errors
    connection.onerror = (event) => {
      console.error(`[PeerConnectionManager] Connection error for ${peerId}:`, event);
      this.callbacks.onError?.(peerId, new Error('Peer connection error'));
    };
  }

  /**
   * Setup data channel handlers
   */
  private setupDataChannelHandlers(dataChannel: RTCDataChannel, peerId: string): void {
    dataChannel.onopen = () => {
      console.log(`[PeerConnectionManager] Data channel opened for ${peerId}`);
    };

    dataChannel.onclose = () => {
      console.log(`[PeerConnectionManager] Data channel closed for ${peerId}`);
    };

    dataChannel.onerror = (error) => {
      console.error(`[PeerConnectionManager] Data channel error for ${peerId}:`, error);
    };

    dataChannel.onmessage = (event) => {
      this.callbacks.onDataChannelMessage?.(peerId, event.data);
    };

    // Update peer's data channel reference
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.dataChannel = dataChannel;
    }
  }

  /**
   * Cleanup all connections
   */
  destroy(): void {
    console.log('[PeerConnectionManager] Destroying all peer connections');
    this.removeAllPeers();
    this.localStream = null;
    this.localPeerId = '';
    this.isInitialized = false;
    this.callbacks = {};
    
    // Unsubscribe from MediaStreamManager
    if (this.streamUnsubscribe) {
      this.streamUnsubscribe();
      this.streamUnsubscribe = null;
    }
  }
}

// Export singleton instance
export const peerConnectionManager = new PeerConnectionManager();
