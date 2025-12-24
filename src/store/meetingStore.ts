/**
 * Meeting Store - Zustand store for meeting state
 * 
 * Manages:
 * - Room state (code, host status)
 * - Participants (local and remote)
 * - Chat messages
 * - Meeting metadata
 * 
 * This store integrates with SignalingClient and PeerConnectionManager
 */

import { create } from 'zustand';
import type { Participant, ChatMessage, MeetingDetails } from '../types/index.js';
import { signalingClient } from '../services/signaling/index.js';
import { peerConnectionManager } from '../services/webrtc/index.js';
import { mediaStreamManager } from '../services/media/MediaStreamManager.js';
import type {
  RoomJoinedData,
  ParticipantJoinedData,
  ParticipantLeftData,
  ParticipantsUpdateData,
  ChatMessageData,
  MediaStateChangedData
} from '../services/signaling/signalingEvents.js';

interface MeetingStore {
  // Room state
  roomCode: string | null;
  isHost: boolean;
  localPeerId: string | null;
  localParticipant: Participant | null;

  // Participants
  participants: Participant[];

  // Chat
  messages: ChatMessage[];

  // Actions - Room
  setRoom: (code: string, isHost: boolean, localPeerId: string) => void;
  leaveRoom: () => void;

  // Actions - Participants
  addParticipant: (participant: Participant) => void;
  removeParticipant: (peerId: string) => void;
  updateParticipant: (peerId: string, updates: Partial<Participant>) => void;
  setLocalParticipant: (participant: Participant) => void;

  // Actions - Chat
  addMessage: (message: ChatMessage) => void;
  clearMessages: () => void;

  // Actions - Integration
  initialize: () => () => void; // Returns cleanup function
}

/**
 * Generate unique message ID
 */
function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).substring(7)}`;
}

export const useMeetingStore = create<MeetingStore>((set, get) => {
  let unsubscribe: (() => void) | null = null;

  return {
    // Initial state
    roomCode: null,
    isHost: false,
    localPeerId: null,
    localParticipant: null,
    participants: [],
    messages: [],

    // Room actions
    setRoom: (code, isHost, localPeerId) => {
      set({
        roomCode: code,
        isHost,
        localPeerId,
        participants: [],
        messages: []
      });
    },

    leaveRoom: () => {
      const { localPeerId } = get();
      
      // Disconnect from signaling
      signalingClient.leaveRoom();
      
      // Close all peer connections
      if (localPeerId) {
        peerConnectionManager.removeAllPeers();
      }

      set({
        roomCode: null,
        isHost: false,
        localPeerId: null,
        localParticipant: null,
        participants: [],
        messages: []
      });

      // Cleanup
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    },

    // Participant actions
    addParticipant: (participant) => {
      set((state) => {
        // Don't add if already exists
        if (state.participants.some(p => p.peerId === participant.peerId)) {
          return state;
        }

        return {
          participants: [...state.participants, participant]
        };
      });
    },

    removeParticipant: (peerId) => {
      set((state) => ({
        participants: state.participants.filter(p => p.peerId !== peerId)
      }));

      // Remove peer connection
      peerConnectionManager.removePeer(peerId);
    },

    updateParticipant: (peerId, updates) => {
      set((state) => {
        // Check if update is actually needed (prevent unnecessary re-renders)
        const existingParticipant = state.participants.find(p => p.peerId === peerId);
        const existingLocal = state.localParticipant?.peerId === peerId ? state.localParticipant : null;
        
        // Check if values actually changed
        const participantChanged = existingParticipant && Object.keys(updates).some(key => {
          return existingParticipant[key as keyof typeof existingParticipant] !== updates[key as keyof typeof updates];
        });
        
        const localChanged = existingLocal && Object.keys(updates).some(key => {
          return existingLocal[key as keyof typeof existingLocal] !== updates[key as keyof typeof updates];
        });
        
        // Only update if something actually changed
        if (!participantChanged && !localChanged) {
          return state; // No change, return same state
        }
        
        // Update in participants list
        const updatedParticipants = state.participants.map(p =>
          p.peerId === peerId ? { ...p, ...updates } : p
        );
        
        // Also update localParticipant if it matches
        const updatedLocalParticipant = state.localParticipant?.peerId === peerId
          ? { ...state.localParticipant, ...updates }
          : state.localParticipant;
        
        return {
          participants: updatedParticipants,
          localParticipant: updatedLocalParticipant || state.localParticipant
        };
      });
    },

    setLocalParticipant: (participant) => {
      const state = get();
      
      // Update or add in participants list
      const existingIndex = state.participants.findIndex(p => p.peerId === participant.peerId);
      
      if (existingIndex >= 0) {
        // Update existing participant
        const updatedParticipants = [...state.participants];
        updatedParticipants[existingIndex] = participant;
        set({ 
          localParticipant: participant,
          participants: updatedParticipants
        });
      } else {
        // Add new participant
        set({ localParticipant: participant });
        get().addParticipant(participant);
      }
    },

    // Chat actions
    addMessage: (message) => {
      set((state) => ({
        messages: [...state.messages, message]
      }));
    },

    clearMessages: () => {
      set({ messages: [] });
    },

    // Initialize: Set up event handlers with SignalingClient
    initialize: () => {
      // Set up SignalingClient callbacks
      signalingClient.setCallbacks({
        onRoomJoined: (data: RoomJoinedData) => {
          const state = get();
          
          set({
            roomCode: data.roomCode,
            isHost: data.isHost
          });

          // Add all existing participants (except local)
          // CRITICAL: When rejoining, the rejoining user should NOT initiate connections.
          // Instead, existing participants will initiate connections via onParticipantJoined.
          // This prevents deadlocks where both sides wait for an offer.
          data.participants.forEach(participantInfo => {
            if (participantInfo.peerId !== state.localPeerId) {
              get().addParticipant({
                id: participantInfo.id,
                peerId: participantInfo.peerId,
                name: participantInfo.name,
                isHost: participantInfo.isHost,
                isLocal: false,
                videoEnabled: true,
                audioEnabled: true,
                stream: null
              });

              // CRITICAL: When joining a room with existing participants, DO NOT create peer connections here.
              // Instead, wait for existing participants to initiate connections via onParticipantJoined.
              // This ensures that existing participants always send offers to new joiners, preventing deadlocks.
              // The only exception is if we're the host joining an empty room (which shouldn't happen, but handle it).
              console.log(`[MeetingStore] Added existing participant ${participantInfo.peerId} to list. Existing participants will initiate connections via onParticipantJoined.`);
            }
          });
        },

        onParticipantJoined: (data: ParticipantJoinedData) => {
          const { participant } = data;
          const state = get();

          console.log(`[MeetingStore] onParticipantJoined: ${participant.name} (${participant.peerId}), localPeerId: ${state.localPeerId}`);

          // Don't add if already exists or is local
          if (participant.peerId === state.localPeerId) {
            console.log(`[MeetingStore] Ignoring participant-joined for local peer ${participant.peerId}`);
            return;
          }

          // Check if participant with same name but different peer ID exists (rejoin scenario)
          const existingParticipant = state.participants.find(p => p.name === participant.name && p.peerId !== participant.peerId);
          if (existingParticipant) {
            console.log(`[MeetingStore] Participant ${participant.name} rejoined with new peer ID: ${existingParticipant.peerId} -> ${participant.peerId}`);
            // Remove old participant and peer connection
            get().removeParticipant(existingParticipant.peerId);
          }

          // Check if participant with same peer ID already exists
          if (state.participants.some(p => p.peerId === participant.peerId)) {
            console.log(`[MeetingStore] Participant ${participant.peerId} already exists in participants list, ensuring peer connection...`);
            // But still ensure peer connection exists and is initiated
            const ensurePeerConnection = async () => {
              if (state.localPeerId) {
                try {
                  // Check if peer connection exists
                  const peer = peerConnectionManager.getPeer(participant.peerId);
                  if (!peer) {
                    // Peer connection doesn't exist, create it (existing participant should initiate)
                    console.log(`[MeetingStore] Creating missing peer connection for ${participant.peerId} (existing participant initiating)`);
                    await peerConnectionManager.addPeer(participant.peerId, true);
                    console.log(`[MeetingStore] Created missing peer connection for ${participant.peerId}`);
                  } else {
                    console.log(`[MeetingStore] Peer connection already exists for ${participant.peerId}, ensuring stream...`);
                    // Ensure stream is added to existing connection
                    const stream = mediaStreamManager.getStream();
                    if (stream) {
                      peerConnectionManager.setLocalStream(stream);
                    }
                  }
                } catch (err) {
                  console.error(`[MeetingStore] Failed to ensure peer connection for ${participant.peerId}:`, err);
                }
              }
            };
            ensurePeerConnection();
            return;
          }

          get().addParticipant({
            id: participant.id,
            peerId: participant.peerId,
            name: participant.name,
            isHost: participant.isHost,
            isLocal: false,
            videoEnabled: true,
            audioEnabled: true,
            stream: null
          });

          // CRITICAL: Ensure stream exists before adding peer connection
          // This makes media streaming completely independent and automatic
          const ensureStreamAndAddPeer = async () => {
            // Check if stream exists in MediaStreamManager
            let stream = mediaStreamManager.getStream();
            
            // If no stream exists, try to get it from media store
            if (!stream) {
              const { useMediaStore } = await import('./mediaStore.js');
              const mediaState = useMediaStore.getState();
              stream = mediaState.localStream;
            }
            
            // If still no stream, log warning (stream will be added automatically when available)
            if (!stream) {
              console.warn(`[MeetingStore] No stream available when ${participant.peerId} joined. Stream will be added automatically when available.`);
            } else {
              console.log(`[MeetingStore] Stream available (${stream.getTracks().length} tracks) when ${participant.peerId} joined`);
            }

            // Add peer connection (stream will be added automatically via PeerConnectionManager subscription)
            // CRITICAL: When a NEW participant joins, EXISTING participants should always initiate
            // This ensures connections are established even if both are guests
            // The host/guest logic only applies to initial room setup, not new joiners
            if (state.localPeerId) {
              try {
                // Always initiate when a new participant joins (we're the existing participant)
                await peerConnectionManager.addPeer(
                  participant.peerId,
                  true // Existing participants always initiate to new joiners
                );
                console.log(`[MeetingStore] Successfully added peer ${participant.peerId} (existing participant initiating)`);
              } catch (err) {
                console.error(`[MeetingStore] Failed to add peer ${participant.peerId}:`, err);
              }
            }
          };

          ensureStreamAndAddPeer();

          // Add system message
          get().addMessage({
            id: generateMessageId(),
            from: 'system',
            fromName: 'System',
            message: `${participant.name} joined the meeting`,
            timestamp: Date.now(),
            isSystem: true
          } as ChatMessage);
        },

        onParticipantLeft: (data: ParticipantLeftData) => {
          const state = get();
          
          // Find participant name before removing
          const participant = state.participants.find(p => p.peerId === data.peerId);
          
          get().removeParticipant(data.peerId);

          // Add system message
          if (participant) {
            get().addMessage({
              id: generateMessageId(),
              from: 'system',
              fromName: 'System',
              message: `${participant.name} left the meeting`,
              timestamp: Date.now(),
              isSystem: true
            } as ChatMessage);
          }
        },

        onParticipantsUpdate: (data: ParticipantsUpdateData) => {
          const state = get();
          
          // Update participants list (merge with existing to preserve stream references)
          const existingPeers = new Map(
            state.participants.map(p => [p.peerId, p])
          );

          const updatedParticipants = data.participants
            .filter(p => p.peerId !== state.localPeerId)
            .map(p => {
              const existing = existingPeers.get(p.peerId);
              return existing || {
                id: p.id,
                peerId: p.peerId,
                name: p.name,
                isHost: p.isHost,
                isLocal: false,
                videoEnabled: true,
                audioEnabled: true,
                stream: null
              };
            });

          // Keep local participant
          const localParticipant = state.participants.find(p => p.isLocal);

          set({
            participants: localParticipant
              ? [localParticipant, ...updatedParticipants]
              : updatedParticipants
          });
        },

        onChatMessage: (data: ChatMessageData) => {
          get().addMessage({
            id: generateMessageId(),
            from: data.from,
            fromName: data.fromName,
            message: data.message,
            timestamp: data.timestamp
          });
        },

        onMediaStateChanged: (data: MediaStateChangedData) => {
          get().updateParticipant(data.peerId, {
            videoEnabled: data.videoEnabled,
            audioEnabled: data.audioEnabled,
            screenSharing: data.screenSharing
          });
        }
      });

      // Set up PeerConnectionManager callbacks
      peerConnectionManager.setCallbacks({
        onStreamAdded: (peerId, stream) => {
          get().updateParticipant(peerId, { stream });
        },
        onStreamRemoved: (peerId) => {
          get().updateParticipant(peerId, { stream: null });
        },
        onConnectionStateChanged: (peerId, state) => {
          // Could update connection quality here
          console.log(`[MeetingStore] ${peerId} connection state: ${state}`);
        },
        onError: (peerId, error) => {
          console.error(`[MeetingStore] Peer connection error for ${peerId}:`, error);
        }
      });

      // Return cleanup function
      return () => {
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
      };
    }
  };
});

