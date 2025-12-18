/**
 * Signaling Service Exports
 */

export { SignalingClient, signalingClient, type SignalingCallbacks, type ConnectionState } from './SignalingClient.js';
export type {
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

