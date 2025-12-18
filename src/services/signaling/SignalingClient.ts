/**
 * SignalingClient
 * 
 * WebSocket client for connecting to the signaling server
 * Handles all Socket.io events and provides a clean API
 * 
 * This is the FOUNDATION - everything depends on this working first
 */

import { io, Socket } from 'socket.io-client';
import { SIGNALING_SERVER_URL, SIGNALING_CONFIG } from '../../config/signaling.js';
import type {
  ParticipantInfo,
  RoomJoinedData,
  RoomErrorData,
  ParticipantJoinedData,
  ParticipantLeftData,
  ParticipantsUpdateData,
  WebRTCOfferData,
  WebRTCAnswerData,
  WebRTCIceCandidateData,
  MediaStateChangedData,
  ChatMessageData,
  ScreenShareStartedData,
  ScreenShareStoppedData
} from './signalingEvents.js';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface SignalingCallbacks {
  onConnected?: () => void;
  onDisconnected?: () => void;
  onRoomJoined?: (data: RoomJoinedData) => void;
  onRoomError?: (data: RoomErrorData) => void;
  onRoomLeft?: () => void;
  onParticipantJoined?: (data: ParticipantJoinedData) => void;
  onParticipantLeft?: (data: ParticipantLeftData) => void;
  onParticipantsUpdate?: (data: ParticipantsUpdateData) => void;
  onWebRTCOffer?: (data: WebRTCOfferData) => void;
  onWebRTCAnswer?: (data: WebRTCAnswerData) => void;
  onWebRTCIceCandidate?: (data: WebRTCIceCandidateData) => void;
  onMediaStateChanged?: (data: MediaStateChangedData) => void;
  onChatMessage?: (data: ChatMessageData) => void;
  onScreenShareStarted?: (data: ScreenShareStartedData) => void;
  onScreenShareStopped?: (data: ScreenShareStoppedData) => void;
  onError?: (error: Error) => void;
}

export class SignalingClient {
  private socket: Socket | null = null;
  private connectionState: ConnectionState = 'disconnected';
  private callbacks: SignalingCallbacks = {};
  private reconnectAttempts = 0;

  /**
   * Connect to signaling server
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket?.connected) {
        resolve();
        return;
      }

      if (this.socket) {
        this.socket.disconnect();
      }

      this.connectionState = 'connecting';
      console.log('[SignalingClient] Connecting to', SIGNALING_SERVER_URL);
      console.log('[SignalingClient] Page protocol:', typeof window !== 'undefined' ? window.location.protocol : 'server-side');

      this.socket = io(SIGNALING_SERVER_URL, {
        ...SIGNALING_CONFIG,
        // Explicitly set path to match server configuration
        path: '/socket.io/',
        // Force upgrade to WebSocket
        upgrade: true,
        // Add extra debugging
        forceNew: true,
        // Explicit transports for better reliability
        transports: ['websocket', 'polling'],
      });

      // Connection successful
      this.socket.on('connect', () => {
        console.log('[SignalingClient] Connected to signaling server');
        this.connectionState = 'connected';
        this.reconnectAttempts = 0;
        this.callbacks.onConnected?.();
        resolve();
      });

      // Connection failed
      this.socket.on('connect_error', (error: Error & { type?: string; description?: unknown; context?: unknown }) => {
        console.error('[SignalingClient] Connection error:', error);
        console.error('[SignalingClient] Error details:', {
          message: error.message,
          type: error.type,
          description: error.description,
          context: error.context
        });
        this.connectionState = 'error';
        this.callbacks.onError?.(error);
        
        // Only reject on initial connection attempt
        if (this.reconnectAttempts === 0) {
          reject(error);
        }
      });

      // Transport error (specific to WebSocket issues)
      this.socket.io.on('error', (error) => {
        console.error('[SignalingClient] IO error:', error);
      });

      // Disconnected
      this.socket.on('disconnect', (reason) => {
        console.log('[SignalingClient] Disconnected:', reason);
        this.connectionState = 'disconnected';
        this.callbacks.onDisconnected?.();
      });

      // Reconnection attempts
      this.socket.io.on('reconnect_attempt', (attempt) => {
        this.reconnectAttempts = attempt;
        console.log(`[SignalingClient] Reconnection attempt ${attempt}`);
      });

      // Setup event listeners
      this.setupEventListeners();
    });
  }

  /**
   * Disconnect from signaling server
   */
  disconnect(): void {
    if (this.socket) {
      console.log('[SignalingClient] Disconnecting...');
      this.socket.disconnect();
      this.socket = null;
      this.connectionState = 'disconnected';
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  /**
   * Get connection state
   */
  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * Set callbacks
   */
  setCallbacks(callbacks: SignalingCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  /**
   * Join a room
   */
  joinRoom(roomCode: string, peerId: string, name: string, isHost: boolean = false): void {
    if (!this.socket?.connected) {
      console.error('[SignalingClient] Cannot join room: not connected');
      this.callbacks.onError?.(new Error('Not connected to signaling server'));
      return;
    }

    console.log(`[SignalingClient] Joining room: ${roomCode} as ${isHost ? 'host' : 'guest'}`);
    this.socket.emit('join-room', {
      roomCode,
      peerId,
      name,
      isHost
    });
  }

  /**
   * Leave current room
   */
  leaveRoom(): void {
    if (!this.socket?.connected) return;

    console.log('[SignalingClient] Leaving room');
    this.socket.emit('leave-room');
  }

  /**
   * Send WebRTC offer
   */
  sendWebRTCOffer(to: string, offer: RTCSessionDescriptionInit): void {
    if (!this.socket?.connected) return;

    this.socket.emit('webrtc-offer', { to, offer });
  }

  /**
   * Send WebRTC answer
   */
  sendWebRTCAnswer(to: string, answer: RTCSessionDescriptionInit): void {
    if (!this.socket?.connected) return;

    this.socket.emit('webrtc-answer', { to, answer });
  }

  /**
   * Send ICE candidate
   */
  sendIceCandidate(to: string, candidate: RTCIceCandidateInit): void {
    if (!this.socket?.connected) return;

    this.socket.emit('webrtc-ice-candidate', { to, candidate });
  }

  /**
   * Send media state
   */
  sendMediaState(videoEnabled: boolean, audioEnabled: boolean, screenSharing?: boolean): void {
    if (!this.socket?.connected) return;

    this.socket.emit('media-state', {
      videoEnabled,
      audioEnabled,
      screenSharing
    });
  }

  /**
   * Send chat message
   */
  sendChatMessage(message: string): void {
    if (!this.socket?.connected) return;

    this.socket.emit('chat-message', { message });
  }

  /**
   * Notify screen share start
   */
  notifyScreenShareStart(): void {
    if (!this.socket?.connected) return;

    this.socket.emit('screen-share-start');
  }

  /**
   * Notify screen share stop
   */
  notifyScreenShareStop(): void {
    if (!this.socket?.connected) return;

    this.socket.emit('screen-share-stop');
  }

  /**
   * Setup event listeners for server events
   */
  private setupEventListeners(): void {
    if (!this.socket) return;

    // Room events
    this.socket.on('room-joined', (data: RoomJoinedData) => {
      console.log('[SignalingClient] Room joined:', data);
      this.callbacks.onRoomJoined?.(data);
    });

    this.socket.on('room-error', (data: RoomErrorData) => {
      console.error('[SignalingClient] Room error:', data);
      this.callbacks.onRoomError?.(data);
    });

    this.socket.on('room-left', () => {
      console.log('[SignalingClient] Room left');
      this.callbacks.onRoomLeft?.();
    });

    // Participant events
    this.socket.on('participant-joined', (data: ParticipantJoinedData) => {
      console.log('[SignalingClient] Participant joined:', data);
      this.callbacks.onParticipantJoined?.(data);
    });

    this.socket.on('participant-left', (data: ParticipantLeftData) => {
      console.log('[SignalingClient] Participant left:', data);
      this.callbacks.onParticipantLeft?.(data);
    });

    this.socket.on('participants-update', (data: ParticipantsUpdateData) => {
      console.log('[SignalingClient] Participants update:', data);
      this.callbacks.onParticipantsUpdate?.(data);
    });

    // WebRTC signaling events
    this.socket.on('webrtc-offer', (data: WebRTCOfferData) => {
      console.log('[SignalingClient] Received WebRTC offer from', data.from);
      this.callbacks.onWebRTCOffer?.(data);
    });

    this.socket.on('webrtc-answer', (data: WebRTCAnswerData) => {
      console.log('[SignalingClient] Received WebRTC answer from', data.from);
      this.callbacks.onWebRTCAnswer?.(data);
    });

    this.socket.on('webrtc-ice-candidate', (data: WebRTCIceCandidateData) => {
      this.callbacks.onWebRTCIceCandidate?.(data);
    });

    // Media events
    this.socket.on('media-state-changed', (data: MediaStateChangedData) => {
      console.log('[SignalingClient] Media state changed:', data);
      this.callbacks.onMediaStateChanged?.(data);
    });

    // Chat events
    this.socket.on('chat-message', (data: ChatMessageData) => {
      this.callbacks.onChatMessage?.(data);
    });

    // Screen share events
    this.socket.on('screen-share-started', (data: ScreenShareStartedData) => {
      console.log('[SignalingClient] Screen share started:', data);
      this.callbacks.onScreenShareStarted?.(data);
    });

    this.socket.on('screen-share-stopped', (data: ScreenShareStoppedData) => {
      console.log('[SignalingClient] Screen share stopped:', data);
      this.callbacks.onScreenShareStopped?.(data);
    });
  }
}

// Export singleton instance
export const signalingClient = new SignalingClient();

