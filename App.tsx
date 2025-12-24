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
      // Initialize meeting system (if not already connected)
      if (!signalingClient.isConnected()) {
        await signalingClient.connect();
      }
      
      // Generate peer ID
      const peerId = `peer-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      
      // Initialize peer connection manager
      peerConnectionManager.initialize(peerId);
      
      // Set room in store
      setRoom(roomCode, isHost, peerId);
      
      // CRITICAL: Set local stream BEFORE joining room to ensure tracks are added to offers
      // Get current stream from media store
      const localStream = useMediaStore.getState().localStream;
      
      // Set local stream in peer connection manager FIRST (before joining)
      // This ensures tracks are included when offers are created
      if (localStream) {
        console.log('[App] Setting local stream before joining room');
        peerConnectionManager.setLocalStream(localStream);
      } else {
        console.warn('[App] No local stream available when joining - media may not work until stream is initialized');
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

      // Navigate to meeting view
      setView(AppView.MEETING);
    } catch (error: any) {
      console.error('[App] Failed to join meeting:', error);
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
