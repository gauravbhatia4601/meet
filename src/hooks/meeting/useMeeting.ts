/**
 * useMeeting Hook
 * 
 * Main hook for meeting management
 * Handles:
 * - Connecting to signaling server
 * - Joining/leaving rooms
 * - Initializing WebRTC connections
 * - Managing meeting lifecycle
 */

import { useEffect, useCallback, useRef } from 'react';
import { useMeetingStore } from '../../store/meetingStore.js';
import { useConnectionStore } from '../../store/connectionStore.js';
import { signalingClient } from '../../services/signaling/index.js';
import { peerConnectionManager } from '../../services/webrtc/index.js';

/**
 * Generate a unique peer ID
 */
function generatePeerId(): string {
  return `peer-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

interface UseMeetingOptions {
  autoConnect?: boolean;
}

export const useMeeting = (options: UseMeetingOptions = {}) => {
  const { autoConnect = false } = options;
  
  // Store selectors
  const roomCode = useMeetingStore(state => state.roomCode);
  const isHost = useMeetingStore(state => state.isHost);
  const localPeerId = useMeetingStore(state => state.localPeerId);
  const setRoom = useMeetingStore(state => state.setRoom);
  const leaveRoom = useMeetingStore(state => state.leaveRoom);
  const initializeMeeting = useMeetingStore(state => state.initialize);
  const setLocalParticipant = useMeetingStore(state => state.setLocalParticipant);
  
  const signalingState = useConnectionStore(state => state.signalingState);
  const isConnected = useConnectionStore(state => state.isConnected);
  const initializeConnection = useConnectionStore(state => state.initialize);
  
  const isInitialized = useRef(false);
  const initializationRef = useRef<(() => void) | null>(null);

  /**
   * Initialize meeting system
   */
  const initialize = useCallback(async () => {
    if (isInitialized.current) {
      console.warn('[useMeeting] Already initialized');
      return;
    }

    try {
      // Initialize connection store
      const cleanupConnection = initializeConnection();
      
      // Initialize meeting store
      const cleanupMeeting = initializeMeeting();
      
      // Store cleanup function
      initializationRef.current = () => {
        cleanupConnection();
        cleanupMeeting();
      };

      // Connect to signaling server
      await signalingClient.connect();
      
      isInitialized.current = true;
      console.log('[useMeeting] Initialized successfully');
    } catch (error) {
      console.error('[useMeeting] Failed to initialize:', error);
      throw error;
    }
  }, [initializeConnection, initializeMeeting]);

  /**
   * Join a room
   */
  const joinRoom = useCallback(async (
    roomCode: string,
    userName: string,
    isHostRoom: boolean = false
  ) => {
    if (!isInitialized.current) {
      await initialize();
    }

    // Generate peer ID if not exists
    const peerId = localPeerId || generatePeerId();
    
    // Initialize peer connection manager
    peerConnectionManager.initialize(peerId);
    
    // Set room in store
    setRoom(roomCode, isHostRoom, peerId);
    
    // Set local participant
    setLocalParticipant({
      id: 'local',
      peerId,
      name: userName,
      isHost: isHostRoom,
      isLocal: true,
      videoEnabled: true,
      audioEnabled: true,
      stream: null
    });

    // Join room via signaling
    signalingClient.joinRoom(roomCode, peerId, userName, isHostRoom);
    
    console.log(`[useMeeting] Joining room ${roomCode} as ${isHostRoom ? 'host' : 'guest'}`);
  }, [localPeerId, initialize, setRoom, setLocalParticipant]);

  /**
   * Leave current room
   */
  const leaveCurrentRoom = useCallback(() => {
    if (!roomCode) {
      console.warn('[useMeeting] No room to leave');
      return;
    }

    console.log('[useMeeting] Leaving room');
    leaveRoom();
  }, [roomCode, leaveRoom]);

  /**
   * Disconnect from meeting system
   */
  const disconnect = useCallback(() => {
    // Leave room if in one
    if (roomCode) {
      leaveCurrentRoom();
    }

    // Disconnect from signaling
    signalingClient.disconnect();
    
    // Cleanup peer connections
    peerConnectionManager.destroy();
    
    // Cleanup initialization
    if (initializationRef.current) {
      initializationRef.current();
      initializationRef.current = null;
    }

    isInitialized.current = false;
    console.log('[useMeeting] Disconnected');
  }, [roomCode, leaveCurrentRoom]);

  // Initialize on mount if autoConnect
  useEffect(() => {
    if (autoConnect) {
      initialize();
    }

    // Cleanup on unmount ONLY if we initialized via autoConnect
    return () => {
      if (autoConnect && isInitialized.current) {
        disconnect();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConnect]); // Only run on mount/unmount - intentionally exclude initialize/disconnect to prevent loops

  return {
    // State
    roomCode,
    isHost,
    localPeerId,
    signalingState,
    isConnected,
    isInitialized: isInitialized.current,

    // Actions
    initialize,
    joinRoom,
    leaveRoom: leaveCurrentRoom,
    disconnect
  };
};

