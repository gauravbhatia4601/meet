import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useSocket } from '../hooks/useSocket';
import { PeerConnectionManager } from '../rtc/PeerConnectionManager';
import VideoTile from '../components/VideoTile';
import ControlsBar from '../components/ControlsBar';
import ChatPanel from '../components/ChatPanel';
import ConfirmDialog from '../components/ConfirmDialog';
import type { ChatMessage, MediaState, Participant } from '../types';
import { normalizeRoomId } from '../lib/roomCode';
import { computeTileLayout } from '../lib/tileLayout';
import { apiUrl } from '../lib/config';

interface PeerState {
  displayName: string;
  stream?: MediaStream;
  micOn: boolean;
  cameraOn: boolean;
  screenShareOn: boolean;
}

const NAME_KEY = 'meet_name';

function getDisplayName(): string {
  return localStorage.getItem(NAME_KEY) ?? 'Guest';
}

function pluralParticipants(n: number): string {
  return new Intl.PluralRules('en').select(n) === 'one' ? 'participant' : 'participants';
}

export default function MeetingRoom() {
  const rawRoomId = useParams().roomId ?? '';
  const roomId = normalizeRoomId(rawRoomId);
  const socket = useSocket();
  const navigate = useNavigate();

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [peers, setPeers] = useState<Map<string, PeerState>>(new Map());
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [displayName, setDisplayName] = useState(getDisplayName);
  const [nameInput, setNameInput] = useState(getDisplayName);
  const [nameReady, setNameReady] = useState(() => !!getDisplayName().trim());
  const [stageSize, setStageSize] = useState<{ width: number; height: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const [screenSharing, setScreenSharing] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const [chatOpen, setChatOpen] = useState(() => searchParams.get('chat') === '1');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState('');
  const [connError, setConnError] = useState('');
  const [raisedHands, setRaisedHands] = useState<Set<string>>(new Set());
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [copied, setCopied] = useState(false);
  const [gateError, setGateError] = useState('');
  const [autoFocusName] = useState(
    () =>
      typeof window !== 'undefined'
        ? window.matchMedia?.('(pointer: fine) and (min-width: 768px)')?.matches ?? false
        : false,
  );
  const gateErrorRef = useRef<HTMLParagraphElement>(null);

  const rtcRef = useRef<PeerConnectionManager | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const mediaStateRef = useRef<MediaState>({ micOn: true, cameraOn: true, screenShareOn: false });
  const peersRef = useRef<Map<string, PeerState>>(new Map());
  const micOnRef = useRef(true);
  const cameraOnRef = useRef(true);
  const navigatedAwayRef = useRef(false);

  useEffect(() => {
    peersRef.current = peers;
  }, [peers]);

  // Surface signaling-server connection failures instead of hanging on
  // "Joining meeting…". This fires regardless of the name gate, so a broken
  // deployment (e.g. VITE_SERVER_URL unset on a static host) is reported.
  useEffect(() => {
    const onConnectError = (err: Error) => {
      setConnError(
        `Could not reach the meeting server. ${err.message ? `(${err.message})` : ''} ` +
          'The signaling server may be offline or not configured for this deployment.',
      );
    };
    const onDisconnect = (reason: string) => {
      if (reason === 'io server disconnect') {
        setConnError('Disconnected by the meeting server.');
      }
    };
    const onConnect = () => setConnError('');
    socket.on('connect_error', onConnectError);
    socket.on('disconnect', onDisconnect);
    socket.on('connect', onConnect);
    return () => {
      socket.off('connect_error', onConnectError);
      socket.off('disconnect', onDisconnect);
      socket.off('connect', onConnect);
    };
  }, [socket]);

  // Track the stage size so tile layout can adapt to device width and the
  // available area (resizes with window and chat panel open/close).
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      setStageSize({ width: el.clientWidth, height: el.clientHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [joined, chatOpen]);

  // Keep chat open/closed state in the URL so it survives reloads and shares.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (chatOpen) next.set('chat', '1');
    else next.delete('chat');
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatOpen]);

  // Reflect the meeting in the document title and theme color so browser tabs,
  // mobile address bars, and PWAs show the correct context. Only applies once
  // we're past the name gate, since the gate itself uses a light surface.
  useEffect(() => {
    if (!nameReady) return;
    document.title = `Meeting ${roomId}`;
    const meta = document.querySelector('meta[name="theme-color"]');
    const prev = meta?.getAttribute('content') ?? null;
    meta?.setAttribute('content', '#202124');
    return () => {
      meta?.setAttribute('content', prev ?? '#ffffff');
      document.title = 'Meet Clone';
    };
  }, [roomId, nameReady]);

  // Surface gate validation errors to assistive tech and keyboard focus.
  useEffect(() => {
    if (gateError) gateErrorRef.current?.focus();
  }, [gateError]);


  const getMedia = useCallback(async (video: boolean, audio: boolean): Promise<MediaStream | null> => {
    try {
      return await navigator.mediaDevices.getUserMedia({ video, audio });
    } catch (err) {
      const name = (err as DOMException)?.name;
      if (name === 'NotAllowedError') setError('Camera/mic permission denied. Check browser settings.');
      else if (name === 'NotFoundError') setError('No camera or microphone found. Connect one and reload.');
      else setError('Could not access media devices. Check permissions and reload.');
      return null;
    }
  }, []);

  // Setup: join the room and acquire local media. Runs only after the user has
  // provided a display name (either from a stored value or the name gate).
  useEffect(() => {
    if (!nameReady) return;
    let cancelled = false;

    async function init() {
      const stream = await getMedia(true, true);
      if (cancelled) return;
      if (!stream) return;

      localStreamRef.current = stream;
      setLocalStream(stream);

      const name = getDisplayName();
      setDisplayName(name);

      // Fetch the ICE config (STUN + optional TURN) from the server so TURN
      // credentials never ship in the client bundle.
      let rtcConfig: RTCConfiguration = { iceServers: [] };
      try {
        const res = await fetch(apiUrl('/api/rtc-config'));
        if (res.ok) {
          const data = (await res.json()) as { iceServers: RTCIceServer[] };
          rtcConfig = { iceServers: data.iceServers };
        }
      } catch (err) {
        console.warn('[rtc] could not fetch rtc-config, using empty ICE servers', err);
      }

      socket.emit('join-room', { roomId, displayName: name }, (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setError(res.error ?? 'This meeting no longer exists.');
          return;
        }
        const rtc = new PeerConnectionManager(socket, {
          onStream: (id, s) => {
            setPeers((prev) => {
              const next = new Map(prev);
              const existing = next.get(id);
              next.set(id, { ...(existing ?? { displayName: '…', micOn: true, cameraOn: true, screenShareOn: false }), stream: s });
              return next;
            });
          },
          onRemoteMediaState: (id, state) => {
            setPeers((prev) => {
              const next = new Map(prev);
              const existing = next.get(id) ?? { displayName: '…', stream: undefined, micOn: true, cameraOn: true, screenShareOn: false };
              next.set(id, { ...existing, ...state });
              return next;
            });
          },
        }, stream, rtcConfig);
        rtcRef.current = rtc;
        setJoined(true);
      });

      socket.on('participants', ({ participants: list }) => {
        setParticipants(list);
        setPeers((prev) => {
          const next = new Map(prev);
          const names = new Map(list.map((p) => [p.socketId, p.displayName]));
          for (const [id, state] of next) {
            if (names.has(id)) next.set(id, { ...state, displayName: names.get(id)! });
          }
          return next;
        });
      });

      socket.on('new-peer', ({ peerSocketId }) => {
        rtcRef.current?.handleNewPeer(peerSocketId);
      });

      socket.on('offer', ({ from, offer }) => {
        void rtcRef.current?.handleOffer(from, offer);
      });

      socket.on('answer', ({ from, answer }) => {
        void rtcRef.current?.handleAnswer(from, answer);
      });

      socket.on('ice-candidate', ({ from, candidate }) => {
        void rtcRef.current?.handleIceCandidate(from, candidate);
      });

      socket.on('peer-disconnected', ({ socketId }) => {
        rtcRef.current?.handlePeerDisconnected(socketId);
        setPeers((prev) => {
          const next = new Map(prev);
          next.delete(socketId);
          return next;
        });
      });

      socket.on('chat-message', (msg) => {
        setMessages((prev) => [...prev, msg]);
      });

      socket.on('media-state', ({ from, state }) => {
        setPeers((prev) => {
          const next = new Map(prev);
          const existing = next.get(from) ?? { displayName: '…', micOn: true, cameraOn: true, screenShareOn: false };
          next.set(from, { ...existing, ...state });
          return next;
        });
      });

      socket.on('raise-hand', ({ from }) => {
        setRaisedHands((prev) => {
          const next = new Set(prev);
          if (next.has(from)) next.delete(from);
          else next.add(from);
          return next;
        });
        setTimeout(() => {
          setRaisedHands((prev) => {
            const next = new Set(prev);
            next.delete(from);
            return next;
          });
        }, 6000);
      });
    }

    void init();

    // Belt-and-suspenders for hard reloads: stop local tracks so the camera
    // LED turns off and the OS doesn't keep the device busy on the fresh tab.
    function handlePageHide() {
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      rtcRef.current?.closeAll();
    }
    window.addEventListener('pagehide', handlePageHide);

    return () => {
      cancelled = true;
      window.removeEventListener('pagehide', handlePageHide);
      if (navigatedAwayRef.current) {
        // Only close peers on real navigation (not just re-renders). On
        // reload, pagehide already cleaned up; leaving the socket connected
        // lets the fresh tab rejoin seamlessly.
        rtcRef.current?.closeAll();
        localStreamRef.current?.getTracks().forEach((t) => t.stop());
      }
      socket.off('participants');
      socket.off('new-peer');
      socket.off('offer');
      socket.off('answer');
      socket.off('ice-candidate');
      socket.off('peer-disconnected');
      socket.off('chat-message');
      socket.off('media-state');
      socket.off('raise-hand');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, socket, nameReady]);

  function updateLocalMediaState(state: Partial<MediaState>) {
    const next = { ...mediaStateRef.current, ...state };
    mediaStateRef.current = next;
    rtcRef.current?.broadcastLocalMediaState(next);
  }

  async function toggleMic() {
    if (micOnRef.current) {
      // Muting: stop the hardware and release the track so the OS stops using
      // the microphone and no audio is captured.
      const stream = localStreamRef.current;
      const audioTrack = stream?.getAudioTracks()[0];
      audioTrack?.stop();
      if (stream) stream.removeTrack(audioTrack!);
      rtcRef.current?.replaceLocalTrack('audio', null);
      micOnRef.current = false;
      setMicOn(false);
      updateLocalMediaState({ micOn: false });
      return;
    }

    // Unmuting: re-acquire the microphone.
    const s = await getMedia(false, true);
    if (!s) return;
    const audioTrack = s.getAudioTracks()[0];
    const stream = localStreamRef.current;
    if (stream) stream.addTrack(audioTrack);
    rtcRef.current?.replaceLocalTrack('audio', audioTrack);
    micOnRef.current = true;
    setMicOn(true);
    updateLocalMediaState({ micOn: true });
  }

  async function toggleCamera() {
    if (cameraOnRef.current) {
      // Stopping video: release the camera hardware and stop the stream.
      const stream = localStreamRef.current;
      const videoTrack = stream?.getVideoTracks()[0];
      videoTrack?.stop();
      if (stream) stream.removeTrack(videoTrack!);
      rtcRef.current?.replaceLocalTrack('video', null);
      cameraOnRef.current = false;
      setCameraOn(false);
      updateLocalMediaState({ cameraOn: false });
      return;
    }

    // Restarting video: re-acquire the camera.
    const s = await getMedia(true, micOnRef.current);
    if (!s) return;
    const videoTrack = s.getVideoTracks()[0];
    const stream = localStreamRef.current;
    if (stream) stream.addTrack(videoTrack);
    rtcRef.current?.replaceLocalTrack('video', videoTrack);
    cameraOnRef.current = true;
    setCameraOn(true);
    updateLocalMediaState({ cameraOn: true });
  }

  async function toggleScreenShare() {
    const stream = localStreamRef.current;
    if (!stream) return;
    try {
      if (!screenSharing) {
        const display = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = display.getVideoTracks()[0];
        setScreenSharing(true);
        updateLocalMediaState({ screenShareOn: true, cameraOn: false });
        setCameraOn(false);
        cameraOnRef.current = false;
        rtcRef.current?.updateTrack(display);
        screenTrack.onended = () => {
          stopScreenShare();
        };
      } else {
        stopScreenShare();
      }
    } catch {
      // User cancelled the picker.
    }
  }

  const stopScreenShare = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    // Release the display-capture hardware.
    stream.getVideoTracks().forEach((t) => t.stop());
    stream.getVideoTracks().forEach((t) => stream.removeTrack(t));
    rtcRef.current?.replaceLocalTrack('video', null);
    setScreenSharing(false);
    updateLocalMediaState({ screenShareOn: false, cameraOn: false });
    // Restore the camera after presentation ends (it was disabled during
    // sharing).
    void getMedia(true, micOnRef.current).then((s) => {
      if (s) {
        const videoTrack = s.getVideoTracks()[0];
        const cur = localStreamRef.current;
        if (cur) cur.addTrack(videoTrack);
        rtcRef.current?.replaceLocalTrack('video', videoTrack);
        cameraOnRef.current = true;
        setCameraOn(true);
        updateLocalMediaState({ cameraOn: true });
      }
    });
  }, [getMedia]);

  const selfTileStream = localStream;

  function submitName(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = nameInput.trim();
    if (!trimmed) {
      setGateError('Please enter your name to join.');
      return;
    }
    setGateError('');
    localStorage.setItem(NAME_KEY, trimmed);
    setDisplayName(trimmed);
    setNameReady(true);
  }

  function cleanupMedia() {
    rtcRef.current?.closeAll();
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    socket.disconnect();
  }

  function leaveRoom() {
    navigatedAwayRef.current = true;
    cleanupMedia();
    setConfirmLeave(false);
    navigate('/');
  }

  function sendChat(text: string) {
    socket.emit('chat-message', { roomId, text });
  }

  function copyInvite() {
    navigator.clipboard?.writeText(`${window.location.origin}/room/${roomId}`).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
      () => undefined,
    );
  }

  const participantCount = participants.length; // roster already includes the local user

  const stageSizeForLayout = stageSize ?? { width: 800, height: 600 };
  const layout = computeTileLayout({
    participantCount,
    width: stageSizeForLayout.width,
    height: stageSizeForLayout.height,
  });

  const tiles: { key: string; node: ReactNode }[] = [];
  if (layout.mode === 'spotlight') {
    // Big main tile for the first user, small self-view in the corner.
    tiles.push({
      key: 'main',
      node: (
        <VideoTile
          stream={peers.size > 0 ? Array.from(peers.values())[0]?.stream : selfTileStream}
          name={
            peers.size > 0
              ? Array.from(peers.values())[0]?.displayName ?? 'Guest'
              : `${displayName} (You)`
          }
          isLocal={peers.size === 0}
          micOn={peers.size > 0 ? Array.from(peers.values())[0]?.micOn ?? true : micOn}
          cameraOn={peers.size > 0 ? Array.from(peers.values())[0]?.cameraOn ?? true : cameraOn}
          screenShareOn={peers.size > 0 ? Array.from(peers.values())[0]?.screenShareOn ?? false : screenSharing}
          raisedHand={peers.size > 0 ? raisedHands.has(Array.from(peers.keys())[0]) : false}
        />
      ),
    });
    tiles.push({
      key: 'self',
      node: (
        <VideoTile
          stream={selfTileStream}
          name={`${displayName} (You)`}
          isLocal
          micOn={micOn}
          cameraOn={cameraOn}
          screenShareOn={screenSharing}
          isSelfView
        />
      ),
    });
  } else {
    tiles.push({
      key: 'self',
      node: (
        <VideoTile
          stream={selfTileStream}
          name={`${displayName} (You)`}
          isLocal
          micOn={micOn}
          cameraOn={cameraOn}
          screenShareOn={screenSharing}
          isSelfView
        />
      ),
    });
    Array.from(peers.entries()).forEach(([id, p]) => {
      tiles.push({
        key: id,
        node: (
          <VideoTile
            stream={p.stream}
            name={p.displayName}
            micOn={p.micOn}
            cameraOn={p.cameraOn}
            screenShareOn={p.screenShareOn}
            raisedHand={raisedHands.has(id)}
          />
        ),
      });
    });
  }

  function renderTiles() {
    const mode = layout.mode;
    if (mode === 'single') {
      return (
        <div className="call__cell" style={{ width: '100%', height: '100%', minWidth: 0, minHeight: 0 }}>
          {tiles[0]?.node}
        </div>
      );
    }
    if (mode === 'spotlight') {
      const first = tiles[0]?.node;
      const second = tiles[1]?.node;
      return (
        <>
          <div className="call__cell call__cell--main" style={{ width: '100%', height: '100%', minWidth: 0, minHeight: 0 }}>
            {first}
          </div>
          <div
            className="call__cell call__cell--corner"
            style={{
              width: layout.secondaryWidth,
              height: layout.secondaryHeight,
              minWidth: 0,
              minHeight: 0,
            }}
          >
            {second}
          </div>
        </>
      );
    }
    return tiles.map((t) => (
      <div
        key={t.key}
        className="call__cell"
        style={{
          width: layout.tileWidth,
          height: layout.tileHeight,
          minWidth: 0,
          minHeight: 0,
        }}
      >
        {t.node}
      </div>
    ));
  }

  if (!nameReady) {
    return (
      <main id="main-content" className="namegate">
        <div className="namegate__card">
          <div className="brand namegate__brand">
            <span className="brand__mark" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <rect x="2" y="5" width="13" height="14" rx="3" fill="var(--primary)" />
                <path d="M15 10.5 22 6.5v11l-7-4" fill="var(--success)" />
              </svg>
            </span>
            <span className="brand__name">Meet Clone</span>
          </div>
          <h1 className="namegate__title">Join the Meeting</h1>
          <p className="namegate__sub">Enter your name so others know who you are.</p>
          <form onSubmit={submitName} className="namegate__form" noValidate>
            <label htmlFor="gate-name" className="field-label">Your name</label>
            <input
              id="gate-name"
              name="name"
              value={nameInput}
              onChange={(e) => {
                setNameInput(e.target.value);
                setGateError('');
              }}
              placeholder="Jane Doe"
              autoComplete="name"
              autoFocus={autoFocusName}
              className="text-input"
            />
            {gateError && (
              <p className="form-error" role="alert" ref={gateErrorRef} tabIndex={-1}>{gateError}</p>
            )}
            <button type="submit" className="btn btn-primary namegate__submit">
              Join Meeting
            </button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <main id="main-content" className="call">
      <h1 className="visually-hidden">{`Meeting ${roomId}`}</h1>
      <div className="call__main">
        <div className="call__stage" ref={stageRef}>
          {!joined && !error && !connError && (
            <div className="call__status">Joining meeting…</div>
          )}
          {connError && (
            <div className="call__error">
              <p className="call__error-text">{connError}</p>
              <Link to="/" className="btn btn-primary" onClick={cleanupMedia}>Go Home</Link>
            </div>
          )}
          {error && (
            <div className="call__error">
              <p className="call__error-text">{error}</p>
              <Link to="/" className="btn btn-primary" onClick={cleanupMedia}>Go Home</Link>
            </div>
          )}
          {joined && (
            <div
              className="call__grid"
              data-mode={layout.mode}
              data-columns={layout.mode === 'grid' || layout.mode === 'scrollable' ? layout.columns : undefined}
            >
              {renderTiles()}
            </div>
          )}
        </div>

        {chatOpen && (
          <ChatPanel messages={messages} mySocketId={socket.id ?? ''} onSend={sendChat} onClose={() => setChatOpen(false)} />
        )}
      </div>

      <div className="call__footer">
        <div className="call__meta">
          <span className="call__room">
            Meeting: <strong translate="no">{roomId}</strong>
          </span>
          <button onClick={copyInvite} className="call__copy">
            {copied ? 'Copied' : 'Copy Invite'}
          </button>
          <span className="visually-hidden" aria-live="polite">{copied ? 'Invite link copied to clipboard' : ''}</span>
          <span className="call__count">
            {participantCount} {pluralParticipants(participantCount)}
          </span>
        </div>
        <ControlsBar
          micOn={micOn}
          cameraOn={cameraOn}
          screenSharing={screenSharing}
          chatOpen={chatOpen}
          onToggleMic={toggleMic}
          onToggleCamera={toggleCamera}
          onToggleScreenShare={toggleScreenShare}
          onToggleChat={() => setChatOpen((v) => !v)}
          onLeave={() => setConfirmLeave(true)}
        />
      </div>
      <ConfirmDialog
        open={confirmLeave}
        title="Leave Meeting?"
        message="You'll be disconnected from this call. You can rejoin with the same link."
        confirmLabel="Leave"
        cancelLabel="Stay"
        onConfirm={leaveRoom}
        onCancel={() => setConfirmLeave(false)}
      />
    </main>
  );
}
