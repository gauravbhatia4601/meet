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

  /**
   * Initialize the manager
   */
  initialize(localPeerId: string): void {
    if (this.isInitialized) {
      console.warn('[PeerConnectionManager] Already initialized');
      return;
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

    console.log('[PeerConnectionManager] Initialized for peer:', localPeerId);
  }

  /**
   * Set local media stream
   */
  setLocalStream(stream: MediaStream | null): void {
    this.localStream = stream;

    // Add tracks to all existing peer connections
    if (stream) {
      stream.getTracks().forEach(track => {
        this.peers.forEach(peer => {
          const sender = peer.connection.getSenders().find(s => {
            return s.track?.kind === track.kind;
          });

          if (sender) {
            sender.replaceTrack(track).catch(err => {
              console.error(`[PeerConnectionManager] Failed to replace track for ${peer.peerId}:`, err);
            });
          } else {
            peer.connection.addTrack(track, stream);
          }
        });
      });
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
   */
  async addPeer(remotePeerId: string, isInitiator: boolean = false): Promise<RTCPeerConnection> {
    // Don't connect to self
    if (remotePeerId === this.localPeerId) {
      throw new Error('Cannot connect to self');
    }

    // Check if peer already exists
    if (this.peers.has(remotePeerId)) {
      console.log(`[PeerConnectionManager] Peer ${remotePeerId} already exists`);
      return this.peers.get(remotePeerId)!.connection;
    }

    console.log(`[PeerConnectionManager] Adding peer: ${remotePeerId} (initiator: ${isInitiator})`);

    // Create RTCPeerConnection
    const config = getRTCConfiguration();
    const connection = new RTCPeerConnection(config);

    // Add local stream tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        connection.addTrack(track, this.localStream!);
      });
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
  }
}

// Export singleton instance
export const peerConnectionManager = new PeerConnectionManager();

