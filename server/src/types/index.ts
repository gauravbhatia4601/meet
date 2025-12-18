/**
 * Server-side Type Definitions
 * 
 * All events, messages, and data structures used in the signaling server
 */

import { Socket } from 'socket.io';

/**
 * Participant information
 */
export interface Participant {
  id: string;           // Socket ID
  peerId: string;       // WebRTC Peer ID (generated client-side)
  name: string;
  isHost: boolean;
  joinedAt: number;     // Timestamp
}

/**
 * Room state
 */
export interface Room {
  code: string;         // Room code (e.g., "abc-xyz-123")
  hostId: string;       // Socket ID of host
  participants: Map<string, Participant>; // Key: socket ID
  createdAt: number;
  lastActivity: number;
}

/**
 * Client-to-Server Events
 */
export interface ClientToServerEvents {
  // Room management
  'join-room': (data: JoinRoomData) => void;
  'leave-room': () => void;

  // WebRTC signaling
  'webrtc-offer': (data: WebRTCOfferData) => void;
  'webrtc-answer': (data: WebRTCAnswerData) => void;
  'webrtc-ice-candidate': (data: WebRTCIceCandidateData) => void;

  // Media control
  'media-state': (data: MediaStateData) => void;

  // Chat
  'chat-message': (data: ChatMessageData) => void;

  // Screen share
  'screen-share-start': () => void;
  'screen-share-stop': () => void;
}

/**
 * Server-to-Client Events
 */
export interface ServerToClientEvents {
  // Room events
  'room-joined': (data: RoomJoinedData) => void;
  'room-error': (data: RoomErrorData) => void;
  'room-left': () => void;

  // Participant events
  'participant-joined': (data: ParticipantJoinedData) => void;
  'participant-left': (data: ParticipantLeftData) => void;
  'participants-update': (data: ParticipantsUpdateData) => void;

  // WebRTC signaling (relayed)
  'webrtc-offer': (data: WebRTCOfferData) => void;
  'webrtc-answer': (data: WebRTCAnswerData) => void;
  'webrtc-ice-candidate': (data: WebRTCIceCandidateData) => void;

  // Media events
  'media-state-changed': (data: MediaStateChangedData) => void;

  // Chat
  'chat-message': (data: ChatMessageData) => void;

  // Screen share
  'screen-share-started': (data: ScreenShareStartedData) => void;
  'screen-share-stopped': (data: ScreenShareStoppedData) => void;
}

/**
 * Socket with custom typing
 */
export interface TypedSocket extends Socket<ClientToServerEvents, ServerToClientEvents> {
  roomCode?: string;
  participantId?: string;
}

/**
 * Event Data Types
 */

export interface JoinRoomData {
  roomCode: string;
  peerId: string;
  name: string;
}

export interface RoomJoinedData {
  roomCode: string;
  isHost: boolean;
  participants: ParticipantInfo[];
}

export interface ParticipantInfo {
  id: string;
  peerId: string;
  name: string;
  isHost: boolean;
}

export interface RoomErrorData {
  code: string;
  message: string;
}

export interface ParticipantJoinedData {
  participant: ParticipantInfo;
}

export interface ParticipantLeftData {
  participantId: string;
  peerId: string;
}

export interface ParticipantsUpdateData {
  participants: ParticipantInfo[];
}

export interface WebRTCOfferData {
  to: string;        // Target peer ID
  from: string;      // Sender peer ID
  offer: RTCSessionDescriptionInit;
}

export interface WebRTCAnswerData {
  to: string;        // Target peer ID
  from: string;      // Sender peer ID
  answer: RTCSessionDescriptionInit;
}

export interface WebRTCIceCandidateData {
  to: string;        // Target peer ID
  from: string;      // Sender peer ID
  candidate: RTCIceCandidateInit;
}

export interface MediaStateData {
  videoEnabled: boolean;
  audioEnabled: boolean;
  screenSharing?: boolean;
}

export interface MediaStateChangedData {
  participantId: string;
  peerId: string;
  videoEnabled: boolean;
  audioEnabled: boolean;
  screenSharing?: boolean;
}

export interface ChatMessageData {
  from: string;      // Participant ID
  fromName: string;
  message: string;
  timestamp: number;
}

export interface ScreenShareStartedData {
  participantId: string;
  peerId: string;
}

export interface ScreenShareStoppedData {
  participantId: string;
  peerId: string;
}

/**
 * Error codes
 */
export enum RoomErrorCode {
  ROOM_NOT_FOUND = 'ROOM_NOT_FOUND',
  ROOM_FULL = 'ROOM_FULL',
  INVALID_ROOM_CODE = 'INVALID_ROOM_CODE',
  ALREADY_IN_ROOM = 'ALREADY_IN_ROOM',
  NAME_REQUIRED = 'NAME_REQUIRED',
  PEER_ID_REQUIRED = 'PEER_ID_REQUIRED',
  SERVER_ERROR = 'SERVER_ERROR'
}

