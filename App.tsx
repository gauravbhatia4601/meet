/**
 * App Component
 * 
 * Main application entry point using the new architecture
 */

import React, { useState, useEffect } from 'react';
import { LandingView, LobbyView, MeetingView } from './src/views/index.js';
import { AppView } from './src/types/index.js';
import { useMeetingStore, useMediaStore } from './src/store/index.js';
import { signalingClient } from './src/services/signaling/index.js';
import { peerConnectionManager } from './src/services/webrtc/index.js';

export default function App() {
    const [view, setView] = useState<AppView>(AppView.LANDING);
  const [roomCode, setRoomCode] = useState<string>('');
  const [isHost, setIsHost] = useState<boolean>(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Initialize stores
  const initializeMeeting = useMeetingStore(state => state.initialize);
  const setRoom = useMeetingStore(state => state.setRoom);
  const setLocalParticipant = useMeetingStore(state => state.setLocalParticipant);

  // Initialize stores on mount
    useEffect(() => {
    const cleanupMeeting = initializeMeeting();
    return cleanupMeeting;
  }, [initializeMeeting]);

  /**
   * Handle navigation between views
   */
  const handleNavigate = (newView: AppView, data?: { roomCode?: string; isHost?: boolean }) => {
    if (data?.roomCode) setRoomCode(data.roomCode);
    if (data?.isHost !== undefined) setIsHost(data.isHost);
    setView(newView);
  };

  /**
   * Handle joining a meeting from lobby
   */
  const handleJoin = async (userName: string) => {
    try {
      setConnectionError(null); // Clear any previous errors
      
      // Initialize meeting system (if not already connected)
      if (!signalingClient.isConnected()) {
        try {
          await signalingClient.connect();
        } catch (error: any) {
          // Enhanced error handling for connection failures
          const errorMessage = error.message || 'Failed to connect to signaling server';
          setConnectionError(errorMessage);
          console.error('[App] Connection error:', error);
          throw error;
        }
      }
      
      // Generate peer ID
      const peerId = `peer-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      
      // Initialize peer connection manager
      peerConnectionManager.initialize(peerId);
      
      // Set room in store
      setRoom(roomCode, isHost, peerId);
      
      // CRITICAL: Ensure stream exists BEFORE joining room
      // This is especially important when rejoining - stream must be available
      // Get stream from MediaStreamManager (centralized source)
      const { mediaStreamManager } = await import('./src/services/media/MediaStreamManager.js');
      let localStream = mediaStreamManager.getStream();
      
      // If no stream in MediaStreamManager, check media store
      if (!localStream) {
        const { useMediaStore } = await import('./src/store/mediaStore.js');
        localStream = useMediaStore.getState().localStream;
        if (localStream) {
          // Set in MediaStreamManager so PeerConnectionManager can access it
          mediaStreamManager.setStream(localStream);
          console.log('[App] Stream found in store, set in MediaStreamManager');
        }
      }
      
      // If still no stream, log warning (MeetingView will initialize it)
      if (!localStream) {
        console.warn('[App] No stream available when joining. MeetingView will initialize stream automatically.');
      } else {
        console.log('[App] Stream available with', localStream.getTracks().length, 'tracks');
        // Set local stream in peer connection manager FIRST (before joining)
        // This ensures tracks are included when offers are created
        // Note: PeerConnectionManager also subscribes to MediaStreamManager, so this is redundant but safe
        peerConnectionManager.setLocalStream(localStream);
      }
      
      // Set local participant
      setLocalParticipant({
                    id: 'local',
        peerId,
                    name: userName,
        isHost,
                    isLocal: true,
        videoEnabled: true,
        audioEnabled: true,
        stream: localStream // Set the actual stream if available
      });

      // Join room via signaling
      signalingClient.joinRoom(roomCode, peerId, userName, isHost);
      
      // Wait a bit for connection to establish
      await new Promise(resolve => setTimeout(resolve, 100));

      // Update stream again in case it was initialized/updated during join
      const currentStream = useMediaStore.getState().localStream;
      if (currentStream && currentStream !== localStream) {
        console.log('[App] Stream updated after join, updating peer connections');
        peerConnectionManager.setLocalStream(currentStream);
      }

      // Clear any errors on success
      setConnectionError(null);
      
      // Navigate to meeting view
                setView(AppView.MEETING);
    } catch (error: any) {
      console.error('[App] Failed to join meeting:', error);
      const errorMessage = error.message || 'Failed to join meeting. Please try again.';
      setConnectionError(errorMessage);
      throw error;
    }
  };

  // Render current view
  switch (view) {
    case AppView.LANDING:
      return <LandingView onNavigate={handleNavigate} />;

    case AppView.LOBBY:
        return (
        <LobbyView
          roomCode={roomCode}
          isHost={isHost}
          onNavigate={handleNavigate}
          onJoin={handleJoin}
        />
      );

    case AppView.MEETING:
        return (
        <MeetingView
          roomCode={roomCode}
          onNavigate={handleNavigate}
        />
      );

    default:
      return <LandingView onNavigate={handleNavigate} />;
  }
}
