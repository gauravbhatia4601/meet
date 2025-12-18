export interface Participant {
  id: string; // PeerID
  name: string;
  isLocal: boolean;
  videoEnabled: boolean;
  audioEnabled: boolean;
  isSpeaking: boolean;
  isScreenShare?: boolean;
  stream?: MediaStream;
  connectionQuality?: 'poor' | 'fair' | 'good' | 'excellent';
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  isSystem?: boolean;
}

export interface MeetingDetails {
  id: string;
  title: string;
  description: string;
  startTime: number;
  isHost: boolean;
}

export enum AppView {
  LANDING = 'LANDING',
  LOBBY = 'LOBBY',
  JOINING = 'JOINING', // Waiting for admit
  WAITING_FOR_HOST = 'WAITING_FOR_HOST',
  MEETING = 'MEETING',
}

export interface DeviceConfig {
  audioInput: string;
  audioOutput: string;
  videoInput: string;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'waiting_host' | 'knocking' | 'connected' | 'denied';

// PeerJS Signaling Types
export type SignalMessage =
  | { type: 'join-request'; name: string }
  | { type: 'join-response'; accepted: boolean; participantName?: string; allParticipants?: Array<{ peerId: string; name: string }> }
  | { type: 'chat'; message: ChatMessage }
  | { type: 'state-update'; video: boolean; audio: boolean; screen?: boolean; participantId?: string }
  | { type: 'participant-joined'; participant: { peerId: string; name: string } }
  | { type: 'participant-left'; peerId: string }
  | { type: 'peer-intro'; name: string; peerId: string };

export interface MediaError {
  type: 'permission-denied' | 'device-not-found' | 'constraint-error' | 'unknown';
  message: string;
  recoverable: boolean;
}

export type ConnectionQuality = 'poor' | 'fair' | 'good' | 'excellent';