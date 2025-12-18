/**
 * Frontend Type Definitions
 * 
 * Shared types for the frontend application
 */

/**
 * Application Views
 */
export enum AppView {
  LANDING = 'LANDING',
  LOBBY = 'LOBBY',
  MEETING = 'MEETING'
}

/**
 * Participant information
 */
export interface Participant {
  id: string;
  peerId: string;
  name: string;
  isHost: boolean;
  isLocal?: boolean;
  videoEnabled: boolean;
  audioEnabled: boolean;
  screenSharing?: boolean;
  isSpeaking?: boolean;
  stream: MediaStream | null;
  joinedAt?: number;
}

/**
 * Chat message
 */
export interface ChatMessage {
  id: string;
  from: string;
  fromName: string;
  message: string;
  timestamp: number;
}

/**
 * Meeting details
 */
export interface MeetingDetails {
  code: string;
  isHost: boolean;
  hostId?: string;
}

/**
 * Device configuration
 */
export interface DeviceConfig {
  audioInput: string;
  audioOutput: string;
  videoInput: string;
}

/**
 * Connection status
 */
export type ConnectionStatus = 
  | 'disconnected' 
  | 'connecting' 
  | 'waiting_host' 
  | 'knocking' 
  | 'connected' 
  | 'denied';

/**
 * Media error types
 */
export interface MediaError {
  type: 'permission-denied' | 'device-not-found' | 'constraint-error' | 'unknown';
  message: string;
}

