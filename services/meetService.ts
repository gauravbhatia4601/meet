import { Participant, ChatMessage, SignalMessage } from '../types';

declare const Peer: any;

export class MeetService {
  private peer: any;
  private connections: Map<string, any> = new Map(); // Data connections
  private mediaConnections: Map<string, any> = new Map(); // Media calls
  private localStream: MediaStream | null = null;
  private hostConn: any = null;
  private localName: string = ''; // Store local user's name
  private knownParticipants: Map<string, { name: string, peerId: string }> = new Map(); // Track all known participants

  // Events
  public onParticipantJoined: (p: Participant) => void = () => { };
  public onParticipantLeft: (id: string) => void = () => { };
  public onMessageReceived: (msg: ChatMessage) => void = () => { };
  public onJoinRequest: (id: string, name: string) => void = () => { };
  public onJoinResponse: (accepted: boolean) => void = () => { };
  public onStreamUpdated: (id: string, stream: MediaStream, metadata?: any) => void = () => { };
  public onParticipantStateChange: (id: string, state: { video: boolean; audio: boolean; screen?: boolean }) => void = () => { };
  public onError: (error: any) => void = () => { };

  constructor() { }

  init(id?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.peer) {
        this.peer.destroy();
        this.peer = null;
      }

      try {
        const peer = new Peer(id, {
          debug: 1, // 0: None, 1: Errors, 2: Warnings, 3: All
          config: {
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: 'stun:global.stun.twilio.com:3478' }
            ]
          }
        });

        peer.on('open', (peerId: string) => {
          console.log('[MeetService] My Peer ID:', peerId);
          this.peer = peer;
          resolve(peerId);
        });

        peer.on('error', (err: any) => {
          console.error('[MeetService] Peer Error:', err);
          this.onError(err);
          if (!this.peer) {
            reject(err);
          }
        });

        peer.on('connection', (conn: any) => {
          this.handleDataConnection(conn);
        });

        peer.on('call', (call: any) => {
          console.log('[MeetService] Incoming call from', call.peer);
          if (this.localStream) {
            call.answer(this.localStream);
            this.handleMediaConnection(call);
          } else {
            console.warn("[MeetService] No local stream. Answering audio-only or empty.");
            call.answer();
            this.handleMediaConnection(call);
          }
        });

      } catch (err) {
        reject(err);
      }
    });
  }

  setLocalStream(stream: MediaStream) {
    this.localStream = stream;
  }

  setLocalName(name: string) {
    this.localName = name;
  }

  replaceVideoTrack(newTrack: MediaStreamTrack) {
    // Replace track in all active peer connections
    this.mediaConnections.forEach((call) => {
      if (call.peerConnection) {
        const sender = call.peerConnection.getSenders().find((s: any) => s.track?.kind === 'video');
        if (sender) {
          sender.replaceTrack(newTrack).catch((err: any) => console.error("Failed to replace video track:", err));
        } else {
          // Add new sender if none exists
          call.peerConnection.addTrack(newTrack).catch((err: any) => console.error("Failed to add video track:", err));
        }
      }
    });

    // Update local stream reference
    if (this.localStream) {
      const oldVideo = this.localStream.getVideoTracks()[0];
      if (oldVideo && oldVideo.id !== newTrack.id) {
        this.localStream.removeTrack(oldVideo);
        oldVideo.stop();
      }
      if (!this.localStream.getVideoTracks().some(t => t.id === newTrack.id)) {
        this.localStream.addTrack(newTrack);
      }
    }
  }

  replaceAudioTrack(newTrack: MediaStreamTrack) {
    // Replace track in all active peer connections
    this.mediaConnections.forEach((call) => {
      if (call.peerConnection) {
        const sender = call.peerConnection.getSenders().find((s: any) => s.track?.kind === 'audio');
        if (sender) {
          sender.replaceTrack(newTrack).catch((err: any) => console.error("Failed to replace audio track:", err));
        } else {
          // Add new sender if none exists
          call.peerConnection.addTrack(newTrack).catch((err: any) => console.error("Failed to add audio track:", err));
        }
      }
    });

    // Update local stream reference
    if (this.localStream) {
      const oldAudio = this.localStream.getAudioTracks()[0];
      if (oldAudio && oldAudio.id !== newTrack.id) {
        this.localStream.removeTrack(oldAudio);
        oldAudio.stop();
      }
      if (!this.localStream.getAudioTracks().some(t => t.id === newTrack.id)) {
        this.localStream.addTrack(newTrack);
      }
    }
  }

  replaceBothTracks(videoTrack: MediaStreamTrack | null, audioTrack: MediaStreamTrack | null) {
    if (videoTrack) this.replaceVideoTrack(videoTrack);
    if (audioTrack) this.replaceAudioTrack(audioTrack);
  }

  // --- HOST ---

  admitParticipant(peerId: string, participantName: string) {
    const conn = this.connections.get(peerId);
    if (conn) {
      console.log('[MeetService] Admitting:', peerId, 'with name:', participantName);
      
      // Store participant info
      this.knownParticipants.set(peerId, { name: participantName, peerId });
      
      // Send join response with participant info
      conn.send({ 
        type: 'join-response', 
        accepted: true,
        participantName: this.localName, // Send host's name
        allParticipants: Array.from(this.knownParticipants.values()).map(p => ({
          peerId: p.peerId,
          name: p.name
        }))
      });

      // Host initiates media call with actual name
      if (this.localStream) {
        const call = this.peer.call(peerId, this.localStream, {
          metadata: { name: this.localName || 'Host' }
        });
        this.handleMediaConnection(call);
      }

      // Broadcast new participant to all existing participants
      const participantInfo = { peerId, name: participantName };
      this.connections.forEach((existingConn, existingPeerId) => {
        if (existingPeerId !== peerId && existingConn.open) {
          existingConn.send({ 
            type: 'participant-joined', 
            participant: participantInfo 
          });
          // Also have existing participants connect to new participant
          this.connectToParticipant(peerId, participantName);
        }
      });

      // Trigger join event
      this.onParticipantJoined({
        id: peerId,
        name: participantName,
        isLocal: false,
        videoEnabled: true,
        audioEnabled: true,
        isSpeaking: false
      });
    }
  }

  denyParticipant(peerId: string) {
    const conn = this.connections.get(peerId);
    if (conn) {
      conn.send({ type: 'join-response', accepted: false });
      setTimeout(() => conn.close(), 500);
    }
  }

  kickParticipant(peerId: string) {
    console.log('[MeetService] Kicking participant:', peerId);

    // Broadcast leave to all other participants
    this.connections.forEach((conn, otherPeerId) => {
      if (otherPeerId !== peerId && conn.open) {
        conn.send({ type: 'participant-left', peerId });
      }
    });
    if (this.hostConn && this.hostConn.open && this.hostConn.peer !== peerId) {
      this.hostConn.send({ type: 'participant-left', peerId });
    }

    // Close data connection
    const conn = this.connections.get(peerId);
    if (conn) {
      conn.close();
      this.connections.delete(peerId);
    }

    // Close media connection
    const call = this.mediaConnections.get(peerId);
    if (call) {
      call.close();
      this.mediaConnections.delete(peerId);
    }

    // Remove from known participants
    this.knownParticipants.delete(peerId);

    // Trigger local update
    this.onParticipantLeft(peerId);
  }

  // --- GUEST ---

  joinMeeting(hostId: string, name: string) {
    if (!this.peer) return;
    if (this.hostConn) this.hostConn.close();

    this.localName = name; // Store local name

    console.log('[MeetService] Connecting to host:', hostId);
    const conn = this.peer.connect(hostId, { reliable: true });
    this.hostConn = conn;

    conn.on('open', () => {
      console.log('[MeetService] Connected to host signaling.');
      conn.send({ type: 'join-request', name });
    });

    conn.on('data', (data: SignalMessage) => {
      if (data.type === 'join-response') {
        if (data.accepted) {
          // Store host's name and connect to all existing participants
          if (data.participantName) {
            this.knownParticipants.set(hostId, { name: data.participantName, peerId: hostId });
          }
          
          // Connect to all existing participants
          if (data.allParticipants && Array.isArray(data.allParticipants)) {
            data.allParticipants.forEach((p: any) => {
              if (p.peerId !== hostId && p.peerId !== this.peer.id) {
                this.connectToParticipant(p.peerId, p.name);
              }
            });
          }
        }
        this.onJoinResponse(data.accepted);
      }
      if (data.type === 'participant-joined') {
        // New participant joined - connect to them
        if (data.participant) {
          const { peerId, name } = data.participant;
          this.knownParticipants.set(peerId, { name, peerId });
          this.connectToParticipant(peerId, name);
          
          // Trigger join event
          this.onParticipantJoined({
            id: peerId,
            name,
            isLocal: false,
            videoEnabled: true,
            audioEnabled: true,
            isSpeaking: false
          });
        }
      }
      if (data.type === 'participant-left') {
        // Participant left
        const peerId = data.peerId;
        this.knownParticipants.delete(peerId);
        this.onParticipantLeft(peerId);
      }
      if (data.type === 'chat') {
        this.onMessageReceived(data.message);
      }
      if (data.type === 'state-update') {
        // Handle remote state updates - use participantId if available (for forwarded messages)
        const participantId = data.participantId || conn.peer;
        this.onParticipantStateChange(participantId, {
          video: data.video,
          audio: data.audio,
          screen: data.screen
        });
      }
    });

    conn.on('close', () => {
      console.log("[MeetService] Host disconnected");
      this.onParticipantLeft(hostId);
    });

    conn.on('error', (e: any) => {
      console.error("[MeetService] Connection error:", e);
      this.onError(e);
    });
  }

  // Connect to another participant (peer-to-peer)
  private connectToParticipant(peerId: string, participantName: string) {
    if (!this.peer || peerId === this.peer.id) return;
    if (this.connections.has(peerId) || this.mediaConnections.has(peerId)) {
      console.log('[MeetService] Already connected to:', peerId);
      return;
    }

    console.log('[MeetService] Connecting to participant:', peerId, participantName);
    
    // Establish data connection
    const dataConn = this.peer.connect(peerId, { reliable: true });
    this.connections.set(peerId, dataConn);

    dataConn.on('open', () => {
      console.log('[MeetService] Data connection established with:', peerId);
      // Send our info
      dataConn.send({ type: 'peer-intro', name: this.localName, peerId: this.peer.id });
    });

    dataConn.on('data', (data: SignalMessage) => {
      if (data.type === 'peer-intro') {
        // Store participant info
        if (data.name && data.peerId) {
          this.knownParticipants.set(data.peerId, { name: data.name, peerId: data.peerId });
        }
      }
      if (data.type === 'chat') {
        this.onMessageReceived(data.message);
      }
      if (data.type === 'state-update') {
        // Use participantId if available (for forwarded messages), otherwise use peerId from connection
        const participantId = data.participantId || peerId;
        this.onParticipantStateChange(participantId, {
          video: data.video,
          audio: data.audio,
          screen: data.screen
        });
      }
    });

    dataConn.on('close', () => {
      this.connections.delete(peerId);
      this.onParticipantLeft(peerId);
    });

    dataConn.on('error', (e: any) => {
      console.error('[MeetService] Data connection error with', peerId, ':', e);
    });

    // Establish media connection if we have local stream
    if (this.localStream) {
      const call = this.peer.call(peerId, this.localStream, {
        metadata: { name: this.localName || 'Participant' }
      });
      this.handleMediaConnection(call);
    } else {
      // Wait for local stream and then call
      const callWhenReady = () => {
        if (this.localStream) {
          const call = this.peer.call(peerId, this.localStream, {
            metadata: { name: this.localName || 'Participant' }
          });
          this.handleMediaConnection(call);
        } else {
          setTimeout(callWhenReady, 500);
        }
      };
      callWhenReady();
    }
  }

  // --- SHARED ---

  broadcastMessage(msg: ChatMessage) {
    this.connections.forEach(conn => {
      if (conn.open) conn.send({ type: 'chat', message: msg });
    });
    if (this.hostConn && this.hostConn.open) {
      this.hostConn.send({ type: 'chat', message: msg });
    }
  }

  broadcastState(state: { video: boolean, audio: boolean, screen?: boolean }, participantId?: string) {
    const msg: SignalMessage = { 
      type: 'state-update', 
      ...state,
      participantId: participantId || this.peer?.id 
    };
    this.connections.forEach(conn => {
      if (conn.open) conn.send(msg);
    });
    if (this.hostConn && this.hostConn.open) {
      this.hostConn.send(msg);
    }
  }

  private handleDataConnection(conn: any) {
    conn.on('data', (data: SignalMessage) => {
      if (data.type === 'join-request') {
        this.connections.set(conn.peer, conn);
        // Store name from join request
        if (data.name) {
          this.knownParticipants.set(conn.peer, { name: data.name, peerId: conn.peer });
        }
        this.onJoinRequest(conn.peer, data.name);
      }
      if (data.type === 'peer-intro') {
        // Store participant info from peer introduction
        if (data.name && data.peerId) {
          this.knownParticipants.set(data.peerId, { name: data.name, peerId: data.peerId });
        }
        // Answer with our intro if we're the host
        if (this.localName && conn.open) {
          conn.send({ type: 'peer-intro', name: this.localName, peerId: this.peer?.id });
        }
      }
      if (data.type === 'chat') {
        this.onMessageReceived(data.message);
        this.connections.forEach(c => {
          if (c.peer !== conn.peer && c.open) c.send(data);
        });
        if (this.hostConn && this.hostConn.open && this.hostConn.peer !== conn.peer) {
          this.hostConn.send(data);
        }
      }
      if (data.type === 'state-update') {
        // Always use participantId from data if available (correct sender), otherwise use conn.peer (direct sender)
        const participantId = data.participantId || conn.peer;
        
        // Update state for the correct participant
        this.onParticipantStateChange(participantId, {
          video: data.video,
          audio: data.audio,
          screen: data.screen
        });
        
        // Only forward if this is a direct message (not already forwarded)
        // If participantId is NOT in data, it means this is the original sender's direct message
        // If participantId IS in data and matches conn.peer, it's also a direct message
        // If participantId IS in data but doesn't match conn.peer, it's already been forwarded
        const isDirectMessage = !data.participantId || data.participantId === conn.peer;
        
        if (isDirectMessage) {
          // Forward to other participants with the correct participantId (the sender)
          const senderId = conn.peer;
          this.connections.forEach(c => {
            if (c.peer !== conn.peer && c.open) {
              c.send({ ...data, participantId: senderId });
            }
          });
          if (this.hostConn && this.hostConn.open && this.hostConn.peer !== conn.peer) {
            this.hostConn.send({ ...data, participantId: senderId });
          }
        }
        // If it's already forwarded (participantId !== conn.peer), don't forward again to avoid loops
      }
      if (data.type === 'participant-joined') {
        // Forward to other participants
        this.connections.forEach(c => {
          if (c.peer !== conn.peer && c.open) {
            c.send(data);
          }
        });
        if (data.participant) {
          const { peerId, name } = data.participant;
          this.knownParticipants.set(peerId, { name, peerId });
          this.onParticipantJoined({
            id: peerId,
            name,
            isLocal: false,
            videoEnabled: true,
            audioEnabled: true,
            isSpeaking: false
          });
        }
      }
      if (data.type === 'participant-left') {
        // Forward to other participants
        this.connections.forEach(c => {
          if (c.peer !== conn.peer && c.open) {
            c.send(data);
          }
        });
        const peerId = data.peerId;
        this.knownParticipants.delete(peerId);
        this.onParticipantLeft(peerId);
      }
    });
    conn.on('close', () => {
      const peerId = conn.peer;
      this.connections.delete(peerId);
      this.knownParticipants.delete(peerId);
      
      // Broadcast leave to other participants
      this.connections.forEach((c, otherPeerId) => {
        if (c.open) {
          c.send({ type: 'participant-left', peerId });
        }
      });
      if (this.hostConn && this.hostConn.open && this.hostConn.peer !== peerId) {
        this.hostConn.send({ type: 'participant-left', peerId });
      }
      
      this.onParticipantLeft(peerId);
    });
  }

  private handleMediaConnection(call: any) {
    this.mediaConnections.set(call.peer, call);

    call.on('stream', (remoteStream: MediaStream) => {
      console.log("[MeetService] Received stream from:", call.peer);
      // Get participant name from metadata or known participants
      const participantInfo = this.knownParticipants.get(call.peer);
      const metadata = call.metadata || {};
      // Always use name from knownParticipants if available (most reliable)
      if (participantInfo) {
        metadata.name = participantInfo.name;
      }
      // If still no name, try to get from metadata
      if (!metadata.name) {
        metadata.name = 'Participant';
      }
      this.onStreamUpdated(call.peer, remoteStream, metadata);
    });

    call.on('close', () => {
      console.log("[MeetService] Call closed:", call.peer);
      this.mediaConnections.delete(call.peer);
      this.onParticipantLeft(call.peer);
    });

    call.on('error', (err: any) => {
      console.error("[MeetService] Call error:", err);
      this.mediaConnections.delete(call.peer);
    });
  }

  checkHostAvailability(hostId: string): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.peer) {
        resolve(false);
        return;
      }

      console.log("[MeetService] Probing host:", hostId);
      const conn = this.peer.connect(hostId, { reliable: true });
      let resolved = false;
      let timer: any;

      const cleanup = () => {
        if (conn) {
          // Remove listeners to avoid side effects
          conn.removeAllListeners();
          conn.close();
        }
        clearTimeout(timer);
      };

      // If connection opens, Host is ONLINE
      conn.on('open', () => {
        if (!resolved) {
          console.log("[MeetService] Probe success - Host found");
          resolved = true;
          cleanup();
          resolve(true);
        }
      });

      // If connection errors, Host is OFFLINE (or unreachable)
      conn.on('error', (err: any) => {
        if (!resolved) {
          console.log("[MeetService] Probe error - Host not found");
          resolved = true;
          cleanup();
          resolve(false);
        }
      });

      // If we immediately get closed, Host might be rejecting or offline
      conn.on('close', () => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve(false);
        }
      });

      // Timeout fallback (2.5s)
      timer = setTimeout(() => {
        if (!resolved) {
          console.log("[MeetService] Probe timeout - Host not found");
          resolved = true;
          cleanup();
          resolve(false);
        }
      }, 2500);
    });
  }

  destroy() {
    if (this.peer) {
      this.peer.destroy();
      this.peer = null;
    }
    this.connections.clear();
    this.mediaConnections.clear();
    this.hostConn = null;
  }
}

export const meetService = new MeetService();