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

              // Add peer connection (initiator if host, responder otherwise)
              if (state.localPeerId) {
                peerConnectionManager.addPeer(
                  participantInfo.peerId,
                  data.isHost // Host initiates connections
                ).catch(err => {
                  console.error(`Failed to add peer ${participantInfo.peerId}:`, err);
                });
              }
            }
          });
        },

        onParticipantJoined: (data: ParticipantJoinedData) => {
          const { participant } = data;
          const state = get();

          // Don't add if already exists or is local
          if (participant.peerId === state.localPeerId) {
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

          // Add peer connection
          if (state.localPeerId) {
            peerConnectionManager.addPeer(
              participant.peerId,
              state.isHost // Host initiates connections
            ).catch(err => {
              console.error(`Failed to add peer ${participant.peerId}:`, err);
            });
          }

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

