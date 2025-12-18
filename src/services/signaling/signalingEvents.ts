/**
 * Signaling Event Types
 * 
 * Type definitions for all signaling events
 * These match the server-side event types
 */

/**
 * Participant information (server format)
 */
export interface ParticipantInfo {
  id: string;
  peerId: string;
  name: string;
  isHost: boolean;
}

/**
 * Room joined response
 */
export interface RoomJoinedData {
  roomCode: string;
  isHost: boolean;
  participants: ParticipantInfo[];
}

/**
 * Room error response
 */
export interface RoomErrorData {
  code: string;
  message: string;
}

/**
 * Participant joined event
 */
export interface ParticipantJoinedData {
  participant: ParticipantInfo;
}

/**
 * Participant left event
 */
export interface ParticipantLeftData {
  participantId: string;
  peerId: string;
}

/**
 * Participants update event
 */
export interface ParticipantsUpdateData {
  participants: ParticipantInfo[];
}

/**
 * WebRTC offer data
 */
export interface WebRTCOfferData {
  to: string;
  from: string;
  offer: RTCSessionDescriptionInit;
}

/**
 * WebRTC answer data
 */
export interface WebRTCAnswerData {
  to: string;
  from: string;
  answer: RTCSessionDescriptionInit;
}

/**
 * WebRTC ICE candidate data
 */
export interface WebRTCIceCandidateData {
  to: string;
  from: string;
  candidate: RTCIceCandidateInit;
}

/**
 * Media state changed event
 */
export interface MediaStateChangedData {
  participantId: string;
  peerId: string;
  videoEnabled: boolean;
  audioEnabled: boolean;
  screenSharing?: boolean;
}

/**
 * Chat message data
 */
export interface ChatMessageData {
  from: string;
  fromName: string;
  message: string;
  timestamp: number;
}

/**
 * Screen share started event
 */
export interface ScreenShareStartedData {
  participantId: string;
  peerId: string;
}

/**
 * Screen share stopped event
 */
export interface ScreenShareStoppedData {
  participantId: string;
  peerId: string;
}

