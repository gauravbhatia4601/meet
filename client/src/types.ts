export interface Participant {
  id: string;
  socketId: string;
  displayName: string;
}

export interface ChatMessage {
  from: string;
  senderName: string;
  text: string;
  timestamp: number;
}

export interface MediaState {
  micOn: boolean;
  cameraOn: boolean;
  screenShareOn: boolean;
}

export interface RemotePeer {
  socketId: string;
  displayName: string;
  stream: MediaStream;
  micOn: boolean;
  cameraOn: boolean;
  screenShareOn: boolean;
}

/** Events the client emits to the server. */
export interface ClientToServerEvents {
  'create-room': (cb: (res: { ok: boolean; roomId?: string; error?: string }) => void) => void;
  'join-room': (
    payload: { roomId: string; displayName: string },
    cb: (res: { ok: boolean; error?: string }) => void
  ) => void;
  offer: (payload: { to: string; offer: RTCSessionDescriptionInit }) => void;
  answer: (payload: { to: string; answer: RTCSessionDescriptionInit }) => void;
  'ice-candidate': (payload: { to: string; candidate: RTCIceCandidateInit }) => void;
  'chat-message': (payload: { roomId: string; text: string }) => void;
  'media-state': (payload: { to: string; state: MediaState }) => void;
  'raise-hand': (payload: { roomId: string }) => void;
}

/** Events the server emits to the client. */
export interface ServerToClientEvents {
  participants: (payload: { participants: Participant[]; hostId: string | null }) => void;
  'new-peer': (payload: { peerSocketId: string }) => void;
  'peer-disconnected': (payload: { socketId: string }) => void;
  offer: (payload: { from: string; offer: RTCSessionDescriptionInit }) => void;
  answer: (payload: { from: string; answer: RTCSessionDescriptionInit }) => void;
  'ice-candidate': (payload: { from: string; candidate: RTCIceCandidateInit }) => void;
  'chat-message': (payload: ChatMessage) => void;
  'media-state': (payload: { from: string; state: MediaState }) => void;
  'raise-hand': (payload: { from: string }) => void;
}
