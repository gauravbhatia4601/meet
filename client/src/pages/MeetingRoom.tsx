import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useSocket } from '../hooks/useSocket';
import { PeerConnectionManager, type PeerStat } from '../rtc/PeerConnectionManager';
import VideoTile from '../components/VideoTile';
import CommandBar from '../components/CommandBar';
import ChatPanel from '../components/ChatPanel';
import ConfirmDialog from '../components/ConfirmDialog';
import type { ChatMessage, MediaState } from '../types';
import { normalizeRoomId } from '../lib/roomCode';
import { COMMANDS } from '../lib/commands';
import { apiUrl } from '../lib/config';

interface PeerState {
  displayName: string;
  stream?: MediaStream;
  micOn: boolean;
  cameraOn: boolean;
  screenShareOn: boolean;
}

type LogLevel = 'ok' | 'error';
interface LogEntry {
  id: number;
  text: string;
  level?: LogLevel;
}
interface Alias {
  name: string;
  command: string;
}

const NAME_KEY = 'meet_name';
const ALIAS_KEY = 'uplink_aliases';
const CHIMES_KEY = 'uplink_chimes';

function getDisplayName(): string {
  return localStorage.getItem(NAME_KEY) ?? 'Guest';
}

function loadAliases(): Alias[] {
  try {
    const raw = localStorage.getItem(ALIAS_KEY);
    return raw ? (JSON.parse(raw) as Alias[]) : [];
  } catch {
    return [];
  }
}

/** Desktop layout breakpoint (matches the CSS @media in index.css). */
function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(
    () =>
      typeof window !== 'undefined'
        ? window.matchMedia?.('(min-width: 768px)')?.matches ?? false
        : false,
  );
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const onChange = () => setIsDesktop(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return isDesktop;
}

export default function MeetingRoom() {
  const rawRoomId = useParams().roomId ?? '';
  const [roomId, setRoomId] = useState(() => (rawRoomId === 'new' ? '' : normalizeRoomId(rawRoomId)));
  const socket = useSocket();
  const navigate = useNavigate();
  const isDesktop = useIsDesktop();

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [peers, setPeers] = useState<Map<string, PeerState>>(new Map());
  const [hostId, setHostId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState(() => localStorage.getItem(NAME_KEY) ?? '');
  const [nameInput, setNameInput] = useState(() => localStorage.getItem(NAME_KEY) ?? '');
  const [nameReady, setNameReady] = useState(false);
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
  const [gateError, setGateError] = useState('');
  const [latency, setLatency] = useState<number | null>(null);
  const [peerStats, setPeerStats] = useState<PeerStat[]>([]);
  const [diagOpen, setDiagOpen] = useState(false);
  const [deviceOpen, setDeviceOpen] = useState(false);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recQuality, setRecQuality] = useState<'high' | 'standard' | 'low'>(
    () => (localStorage.getItem('uplink_rec_quality') as 'high' | 'standard' | 'low') ?? 'high',
  );
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [selectedAudioId, setSelectedAudioId] = useState<string | null>(null);
  const [aliases, setAliases] = useState<Alias[]>(loadAliases);
  const [unread, setUnread] = useState(0);
  const [chimesOn, setChimesOn] = useState(() => localStorage.getItem(CHIMES_KEY) !== 'off');
  const [mediaError, setMediaError] = useState('');
  const [micLevel, setMicLevel] = useState(0);
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([
    { id: 0, text: '> ENCRYPTION: ACTIVE', level: 'ok' },
    { id: 1, text: '> HANDSHAKE: SUCCESS', level: 'ok' },
    { id: 2, text: '> AWAITING INPUT…' },
  ]);
  const [autoFocusName] = useState(
    () =>
      typeof window !== 'undefined'
        ? window.matchMedia?.('(pointer: fine) and (min-width: 768px)')?.matches ?? false
        : false,
  );
  const gateErrorRef = useRef<HTMLParagraphElement>(null);
  const sysLogsRef = useRef<HTMLDivElement>(null);
  const logIdRef = useRef(3);
  const commandInputRef = useRef<HTMLInputElement>(null);
  const rtcConfigRef = useRef<RTCConfiguration>({ iceServers: [] });
  const joinedRef = useRef(false);

  const rtcRef = useRef<PeerConnectionManager | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const mediaStateRef = useRef<MediaState>({ micOn: true, cameraOn: true, screenShareOn: false });
  const micOnRef = useRef(true);
  const cameraOnRef = useRef(true);
  const navigatedAwayRef = useRef(false);
  const peersRef = useRef<Map<string, PeerState>>(new Map());
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const chatVisibleRef = useRef(true);
  const chimesOnRef = useRef(chimesOn);
  const chimeCtxRef = useRef<AudioContext | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const autoVideoOffRef = useRef(false);
  const poorCountRef = useRef(0);
  const goodCountRef = useRef(0);
  chatVisibleRef.current = isDesktop || chatOpen;
  chimesOnRef.current = chimesOn;

  const pushLog = useCallback((text: string, level?: LogLevel) => {
    setLogs((prev) => [...prev, { id: logIdRef.current++, text, level }].slice(-80));
  }, []);

  const toastTimerRef = useRef<number | null>(null);
  const showToast = useCallback((text: string) => {
    setToast({ id: Date.now(), text });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2500);
  }, []);

  // Extracted RTC callbacks (shared by init and rejoin).
  const handleStream = useCallback((id: string, s: MediaStream) => {
    setPeers((prev) => {
      const next = new Map(prev);
      const existing = next.get(id);
      next.set(id, { ...(existing ?? { displayName: '…', micOn: true, cameraOn: true, screenShareOn: false }), stream: s });
      return next;
    });
  }, []);

  const handleRemoteMediaState = useCallback((id: string, state: MediaState) => {
    setPeers((prev) => {
      const next = new Map(prev);
      const existing = next.get(id) ?? { displayName: '…', stream: undefined, micOn: true, cameraOn: true, screenShareOn: false };
      next.set(id, { ...existing, ...state });
      return next;
    });
  }, []);

  const handleChat = useCallback((id: string, text: string, ts: number) => {
    if (!chatVisibleRef.current) setUnread((u) => u + 1);
    setMessages((prev) => [...prev, { from: id, senderName: peersRef.current.get(id)?.displayName ?? '…', text, timestamp: ts }]);
  }, []);

  const stopMicMeter = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    setMicLevel(0);
  }, []);

  const startMicMeter = useCallback((stream: MediaStream) => {
    stopMicMeter();
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) return;
    try {
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const loop = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        setMicLevel(Math.min(1, rms * 2.5));
        rafRef.current = requestAnimationFrame(loop);
      };
      loop();
    } catch {
      // AudioContext unavailable; meter stays at 0.
    }
  }, [stopMicMeter]);

  // Subtle terminal beep when peers join/leave (toggle with /chimes).
  const playChime = useCallback((kind: 'join' | 'leave' | 'hand') => {
    // Hand-raise is an alert — always plays; join/leave are ambiance (gated).
    if (kind !== 'hand' && !chimesOnRef.current) return;
    try {
      const ctx = chimeCtxRef.current ?? (chimeCtxRef.current = new AudioContext());
      if (ctx.state === 'suspended') void ctx.resume();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.type = 'square';
      const t = ctx.currentTime;
      if (kind === 'hand') {
        o.frequency.setValueAtTime(660, t);
        o.frequency.setValueAtTime(990, t + 0.08);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.06, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
        g.gain.exponentialRampToValueAtTime(0.06, t + 0.09);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
        o.start(t);
        o.stop(t + 0.2);
      } else {
        o.frequency.value = kind === 'join' ? 880 : 440;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.04, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
        o.start(t);
        o.stop(t + 0.16);
      }
    } catch {
      // AudioContext unavailable
    }
  }, []);

  useEffect(() => {
    sysLogsRef.current?.scrollTo({ top: sysLogsRef.current.scrollHeight });
  }, [logs]);

  useEffect(() => {
    peersRef.current = peers;
  }, [peers]);

  useEffect(() => {
    try {
      localStorage.setItem(ALIAS_KEY, JSON.stringify(aliases));
    } catch {
      // ignore quota / privacy-mode errors
    }
  }, [aliases]);

  useEffect(() => {
    localStorage.setItem(CHIMES_KEY, chimesOn ? 'on' : 'off');
  }, [chimesOn]);

  // Clear the chat unread badge whenever chat is visible.
  useEffect(() => {
    if (isDesktop || chatOpen) setUnread(0);
  }, [isDesktop, chatOpen]);

  // Acquire camera + mic once, on mount, so the pre-join lobby can preview them
  // and the user can enable/disable each before connecting. The same stream is
  // reused by the call, so the lobby choices carry straight into the meeting.
  useEffect(() => {
    let cancelled = false;
    if (!navigator.mediaDevices?.getUserMedia) {
      setMediaError('Camera/mic not available in this browser. You can still join without media.');
      setMicOn(false);
      setCameraOn(false);
      micOnRef.current = false;
      cameraOnRef.current = false;
      return;
    }
    const storedVideoId = localStorage.getItem("uplink_video_device");
    const storedAudioId = localStorage.getItem("uplink_audio_device");
    // Extracted handlers so the stale-device retry can reuse them.
    function onAcquired(stream: MediaStream) {
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      localStreamRef.current = stream;
      setLocalStream(stream);
      setMicOn(true);
      setCameraOn(true);
      micOnRef.current = true;
      cameraOnRef.current = true;
      navigator.mediaDevices.enumerateDevices().then((devices) => {
        if (cancelled) return;
        setVideoDevices(devices.filter((d) => d.kind === "videoinput"));
        setAudioDevices(devices.filter((d) => d.kind === "audioinput"));
        const videoTrack = stream.getVideoTracks()[0];
        const audioTrack = stream.getAudioTracks()[0];
        setSelectedVideoId(storedVideoId || videoTrack?.getSettings().deviceId || "");
        setSelectedAudioId(storedAudioId || audioTrack?.getSettings().deviceId || "");
      });
    }

    function onError(err: unknown) {
      if (cancelled) return;
      const name = (err as DOMException)?.name;
      if (name === 'NotAllowedError') setMediaError('Camera/mic permission denied — you can still join without media.');
      else if (name === 'NotFoundError') setMediaError('No camera or microphone found — you can still join without media.');
      else setMediaError('Could not access camera/mic — you can still join without media.');
      setMicOn(false);
      setCameraOn(false);
      micOnRef.current = false;
      cameraOnRef.current = false;
    }

    navigator.mediaDevices
      .getUserMedia({
        video: storedVideoId ? { deviceId: { exact: storedVideoId } } : true,
        audio: storedAudioId ? { deviceId: { exact: storedAudioId } } : true,
      })
      .then(onAcquired)
      .catch(async (err) => {
        // If a stored device ID is stale (device unplugged/changed), clear it
        // and retry with default devices so the permission prompt still appears.
        if (storedVideoId || storedAudioId) {
          localStorage.removeItem('uplink_video_device');
          localStorage.removeItem('uplink_audio_device');
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            onAcquired(stream);
            return;
          } catch {
            // fall through to the normal error handler
          }
        }
        onError(err);
      });
    return () => {
      cancelled = true;
      // Release hardware on a real unmount (leaving the page). The gate -> call
      // flip does NOT unmount this component, so the stream survives into the call.
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Mic level meter — only in the pre-join lobby, with the mic on.
  useEffect(() => {
    if (nameReady || !micOn || !localStream) return;
    startMicMeter(localStream);
    return () => stopMicMeter();
  }, [nameReady, micOn, localStream, startMicMeter, stopMicMeter]);

  // Attach the preview stream to the lobby video element.
  useEffect(() => {
    const el = previewVideoRef.current;
    if (!el) return;
    el.srcObject = cameraOn && localStream ? localStream : null;
  }, [cameraOn, localStream]);

  // Surface signaling-server connection failures instead of hanging on the
  // "Establishing uplink…" state.
  useEffect(() => {
    const onConnectError = (err: Error) => {
      setConnError(
        `Could not reach the meeting server. ${err.message ? `(${err.message})` : ''} ` +
          'The signaling server may be offline or not configured for this deployment.',
      );
      pushLog(`> ERR: uplink failed ${err.message ? `(${err.message})` : ''}`, 'error');
    };
    const onDisconnect = (reason: string) => {
      if (reason === 'io server disconnect') {
        setConnError('Disconnected by the meeting server.');
        pushLog('> ERR: disconnected by server', 'error');
      }
    };
    const onConnect = () => {
      setConnError('');
      pushLog('> UPLINK ESTABLISHED', 'ok');
      if (joinedRef.current) {
        rejoin();
      }
    };
    socket.on('connect_error', onConnectError);
    socket.on('disconnect', onDisconnect);
    socket.on('connect', onConnect);
    return () => {
      socket.off('connect_error', onConnectError);
      socket.off('disconnect', onDisconnect);
      socket.off('connect', onConnect);
    };
  }, [socket, pushLog]);

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

  // Reflect the meeting in the document title and theme color.
  useEffect(() => {
    if (!nameReady) return;
    document.title = `Uplink — ${roomId}`;
    const meta = document.querySelector('meta[name="theme-color"]');
    const prev = meta?.getAttribute('content') ?? null;
    meta?.setAttribute('content', '#000000');
    return () => {
      meta?.setAttribute('content', prev ?? '#000000');
      document.title = 'Uplink // Secure Signal';
    };
  }, [roomId, nameReady]);

  // Surface gate validation errors to assistive tech and keyboard focus.
  useEffect(() => {
    if (gateError) gateErrorRef.current?.focus();
  }, [gateError]);

  // Live per-peer network diagnostics (RTT/loss/jitter/bitrate/codec/relay) for
  // the NET_CONSOLE, plus received audio levels for active-speaker detection,
  // and the worst-case RTT for the HUD footer.
  useEffect(() => {
    if (!joined) return;
    let active = true;
    const measure = async () => {
      const stats = (await rtcRef.current?.getPeerStats()) ?? [];
      if (!active) return;
      setPeerStats(stats);
      const maxRtt = stats.reduce((m, s) => (s.rttMs != null ? Math.max(m, s.rttMs) : m), 0);
      setLatency(stats.some((s) => s.rttMs != null) ? maxRtt : null);

      // Adaptive video: auto-disable camera on very poor network, keep audio.
      if (!autoVideoOffRef.current && maxRtt > 500) {
        poorCountRef.current++;
        if (poorCountRef.current >= 3 && cameraOnRef.current) {
          autoVideoOffRef.current = true;
          poorCountRef.current = 0;
          showToast('Video paused — poor connection');
          void toggleCamera();
        }
      } else {
        poorCountRef.current = 0;
      }
      if (autoVideoOffRef.current && maxRtt < 200) {
        goodCountRef.current++;
        if (goodCountRef.current >= 5) {
          autoVideoOffRef.current = false;
          goodCountRef.current = 0;
          showToast('Connection improved — use /cam to re-enable video');
        }
      } else if (maxRtt >= 200) {
        goodCountRef.current = 0;
      }
    };
    void measure();
    const id = window.setInterval(measure, 1000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [joined]);


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

  // Setup: join the room. For a brand-new meeting, create it now (after the
  // name is set). Local media was acquired on mount for the pre-join lobby and
  // is reused, so the mic/camera choices carry into the call.
  useEffect(() => {
    if (!nameReady) return;
    let cancelled = false;

    async function init() {
      let rid = roomId;
      if (!rid) {
        // New meeting: create the room now that the name is set, so a
        // nameless user can never create a room.
        rid = await new Promise<string>((resolve) =>
          socket.emit('create-room', (res) => resolve(res.ok && res.roomId ? res.roomId : '')),
        );
        if (cancelled) return;
        if (!rid) {
          setError('Could not create meeting. Please try again.');
          return;
        }
        setRoomId(rid);
        navigate(`/room/${rid}`, { replace: true });
        return; // the roomId change re-runs init, which then joins
      }

      const stream = localStreamRef.current ?? new MediaStream();
      if (cancelled) return;
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

      rtcConfigRef.current = rtcConfig;
      socket.emit('join-room', { roomId: rid, displayName: name }, (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setError(res.error ?? 'This meeting no longer exists.');
          return;
        }
        const rtc = new PeerConnectionManager(socket, {
          onStream: handleStream,
          onRemoteMediaState: handleRemoteMediaState,
          onChat: handleChat,
        }, stream, rtcConfig);
        rtcRef.current = rtc;
        joinedRef.current = true;
        setJoined(true);
        pushLog('> SYNC COMPLETE', 'ok');
      });

      socket.on('participants', ({ participants: list, hostId: h }) => {
        setHostId(h);
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
        pushLog('> NEW_NODE uplink');
        playChime('join');
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
        pushLog('> NODE dropped');
        playChime('leave');
      });

      // Fallback chat path: only used before datachannels are open (no peers
      // connected yet). Once peers connect, chat goes E2E over datachannels.
      socket.on('chat-message', (msg) => {
        if (!chatVisibleRef.current) setUnread((u) => u + 1);
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
        playChime('hand');
        const handName = peersRef.current.get(from)?.displayName ?? 'Someone';
        showToast(`✋ ${handName} raised their hand`);
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

  async function switchVideoDevice(deviceId: string) {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId } },
      audio: false,
    });
    const newTrack = stream.getVideoTracks()[0];
    const oldTrack = localStreamRef.current?.getVideoTracks()[0];
    if (oldTrack) oldTrack.stop();
    if (localStreamRef.current) {
      localStreamRef.current.removeTrack(oldTrack!);
      localStreamRef.current.addTrack(newTrack);
    }
    rtcRef.current?.replaceLocalTrack("video", newTrack);
    localStorage.setItem("uplink_video_device", deviceId);
    setSelectedVideoId(deviceId);
  }

  async function switchAudioDevice(deviceId: string) {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: { deviceId: { exact: deviceId } },
    });
    const newTrack = stream.getAudioTracks()[0];
    const oldTrack = localStreamRef.current?.getAudioTracks()[0];
    if (oldTrack) oldTrack.stop();
    if (localStreamRef.current) {
      localStreamRef.current.removeTrack(oldTrack!);
      localStreamRef.current.addTrack(newTrack);
    }
    rtcRef.current?.replaceLocalTrack("audio", newTrack);
    localStorage.setItem("uplink_audio_device", deviceId);
    setSelectedAudioId(deviceId);
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
    stream.getVideoTracks().forEach((t) => t.stop());
    stream.getVideoTracks().forEach((t) => stream.removeTrack(t));
    rtcRef.current?.replaceLocalTrack('video', null);
    setScreenSharing(false);
    updateLocalMediaState({ screenShareOn: false, cameraOn: false });
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

  function submitName(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = nameInput.trim();
    if (!trimmed) {
      setGateError('Please enter your name to join.');
      return;
    }
    setGateError('');
    setError('');
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
    joinedRef.current = false;
    cleanupMedia();
    setConfirmLeave(false);
    navigate('/');
  }

  // Network-drop recovery: re-join the room on socket reconnect so the call
  // survives a brief network drop (Wi-Fi -> cellular, etc.) without a reload.
  function rejoin() {
    rtcRef.current?.closeAll();
    const stream = localStreamRef.current;
    if (!stream) return;
    const rtc = new PeerConnectionManager(socket, {
      onStream: handleStream,
      onRemoteMediaState: handleRemoteMediaState,
      onChat: handleChat,
    }, stream, rtcConfigRef.current);
    rtcRef.current = rtc;
    socket.emit('join-room', { roomId, displayName: getDisplayName() }, (res) => {
      if (!res.ok) {
        setConnError(res.error ?? 'This meeting no longer exists.');
        return;
      }
      joinedRef.current = true;
      setJoined(true);
      pushLog('> UPLINK RESTORED', 'ok');
      showToast('Reconnected');
    });
  }

  // Send chat E2E over datachannels; fall back to the signaling server only
  // when no peer datachannel is open yet.
  function sendChat(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const sent = rtcRef.current?.sendChat(trimmed) ?? false;
    if (sent) {
      setMessages((prev) => [
        ...prev,
        { from: socket.id ?? '', senderName: displayName || getDisplayName(), text: trimmed, timestamp: Date.now() },
      ]);
    } else {
      socket.emit('chat-message', { roomId, text: trimmed });
    }
  }

  function copyInvite() {
    navigator.clipboard?.writeText(`${window.location.origin}/room/${roomId}`).then(
      () => pushLog('> INVITE_LINK copied', 'ok'),
      () => pushLog('> ERR: could not copy invite link', 'error'),
    );
  }

  function raiseHand() {
    socket.emit('raise-hand', { roomId });
  }

  function startRecording(quality?: string) {
    const q = (quality ?? recQuality) as 'high' | 'standard' | 'low';
    const stream = localStreamRef.current;
    if (!stream || stream.getTracks().length === 0) {
      showToast('No media to record');
      return;
    }
    const bitrate = q === 'high' ? 5_000_000 : q === 'standard' ? 2_500_000 : 800_000;
    try {
      const recorder = new MediaRecorder(stream, {
        mimeType: 'video/webm;codecs=vp8,opus',
        videoBitsPerSecond: bitrate,
        audioBitsPerSecond: 128_000,
      });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `uplink-${roomId}-${Date.now()}.webm`;
        a.click();
        URL.revokeObjectURL(url);
        chunksRef.current = [];
      };
      recorder.start(1000);
      recorderRef.current = recorder;
      setRecording(true);
      showToast(`Recording (${q})`);
      pushLog(`> /RECORD :: started (${q})`, 'ok');
    } catch {
      showToast('Recording not supported');
      pushLog('> ERR: recording not supported', 'error');
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
    showToast('Recording saved');
    pushLog('> /RECORD :: stopped, file saved', 'ok');
  }

  function changeQuality(q: 'high' | 'standard' | 'low') {
    setRecQuality(q);
    localStorage.setItem('uplink_rec_quality', q);
    if (recording) {
      stopRecording();
      setTimeout(() => startRecording(q), 200);
    }
  }

  // --- Command parser: the call is driven by slash commands typed in the bar.
  function runCommand(raw: string) {
    const input = raw.trim();
    if (!input) return;
    const lower = input.toLowerCase();
    const body = lower.startsWith('/') ? lower.slice(1) : lower;
    const [actionRaw, ...args] = body.split(/\s+/);

    // /alias <name> <command> — define a macro (persisted).
    if (actionRaw === 'alias') {
      const [name, ...cmdParts] = args;
      const cmd = cmdParts.join(' ').trim().replace(/^\/+/, '');
      const cleanName = (name ?? '').replace(/^\/+/, '');
      if (!cleanName || !cmd) {
        pushLog('> ERR: usage /alias <name> <command>', 'error');
        showToast('Usage: /alias <name> <command>');
        return;
      }
      setAliases((prev) => [...prev.filter((a) => a.name !== cleanName), { name: cleanName, command: cmd }]);
      showToast(`Alias /${cleanName} → /${cmd}`);
      pushLog(`> alias /${cleanName} -> /${cmd}`, 'ok');
      return;
    }

    // Resolve one level of alias for the action.
    const alias = aliases.find((a) => a.name === actionRaw);
    const action = alias ? alias.command : actionRaw;

    switch (action) {
      case 'mute':
      case 'unmute':
      case 'mic':
        pushLog(`> /${action.toUpperCase()} :: mic`, 'ok');
        showToast(micOnRef.current ? 'Mic muted' : 'Mic unmuted');
        void toggleMic();
        break;
      case 'cam':
      case 'camera':
      case 'video':
        pushLog(`> /${action.toUpperCase()} :: camera`, 'ok');
        showToast(cameraOnRef.current ? 'Camera off' : 'Camera on');
        void toggleCamera();
        break;
      case 'share':
      case 'screen':
      case 'present':
        pushLog(`> /${action.toUpperCase()} :: screen_share`, 'ok');
        showToast(screenSharing ? 'Screen share stopped' : 'Screen share started');
        void toggleScreenShare();
        break;
      case 'hand':
      case 'raise':
        pushLog('> /HAND :: raise_hand', 'ok');
        showToast('Hand raised');
        raiseHand();
        break;
      case 'chat':
      case 'comms':
        setChatOpen((v) => !v);
        pushLog('> /CHAT :: comms_toggle', 'ok');
        showToast(chatOpen ? 'Chat closed' : 'Chat opened');
        break;
      case 'copy':
      case 'invite':
      case 'link':
        copyInvite();
        showToast('Invite link copied');
        break;
      case 'diag':
      case 'net':
        setDiagOpen((v) => !v);
        pushLog('> /DIAG :: net_console', 'ok');
        showToast(diagOpen ? 'Diagnostics closed' : 'Diagnostics open');
        break;
      case 'device':
        setDeviceOpen((v) => !v);
        pushLog('> /DEVICE :: device_picker', 'ok');
        showToast(deviceOpen ? 'Device picker closed' : 'Device picker open');
        break;
      case 'who':
      case 'people':
        setRosterOpen((v) => !v);
        pushLog('> /WHO :: people', 'ok');
        showToast(rosterOpen ? 'Roster closed' : 'Roster open');
        break;
      case 'record':
      case 'rec':
        if (args[0] === 'high' || args[0] === 'standard' || args[0] === 'low') {
          const q = args[0] as 'high' | 'standard' | 'low';
          setRecQuality(q);
          localStorage.setItem('uplink_rec_quality', q);
          showToast(`Quality: ${q}`);
          pushLog(`> /RECORD :: quality ${q}`, 'ok');
          if (recording) {
            stopRecording();
            setTimeout(() => startRecording(q), 200);
          }
        } else {
          if (recording) stopRecording();
          else startRecording();
        }
        break;
      case 'chimes':
        setChimesOn((v) => !v);
        pushLog('> /CHIMES :: toggle', 'ok');
        showToast(chimesOn ? 'Chimes off' : 'Chimes on');
        break;
      case 'exit':
      case 'leave':
      case 'quit':
        pushLog('> /EXIT :: leave_session', 'ok');
        setConfirmLeave(true);
        break;
      case 'help':
      case '?':
      case 'commands':
        pushLog(`> commands: ${COMMANDS.map((c) => c.label).join(' ')}`, 'ok');
        showToast('Commands listed in SYS_LOGS');
        break;
      default:
        pushLog(`> ERR: unknown command /${actionRaw}`, 'error');
        showToast(`Unknown command: /${actionRaw}`);
    }
  }

  // Global operator shortcuts: "/" focuses the command bar; Alt+<key> runs a
  // command (M=mic, C=cam, S=share, H=hand, D=diag, K=focus, X=leave).
  useEffect(() => {
    if (!nameReady) return;
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (e.key === '/' && !typing) {
        e.preventDefault();
        commandInputRef.current?.focus();
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        switch (e.key.toLowerCase()) {
          case 'm': e.preventDefault(); void toggleMic(); break;
          case 'c': e.preventDefault(); void toggleCamera(); break;
          case 's': e.preventDefault(); void toggleScreenShare(); break;
          case 'h': e.preventDefault(); raiseHand(); break;
          case 'd': e.preventDefault(); setDiagOpen((v) => !v); break;
          case 'k': e.preventDefault(); commandInputRef.current?.focus(); break;
          case 'x': e.preventDefault(); setConfirmLeave(true); break;
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const selfTileStream = localStream;
  const peerEntries = Array.from(peers.entries());
  const nodeCount = peers.size + 1;
  const liveStatus = connError ? 'OFFLINE' : joined ? 'LIVE' : 'LINKING';
  const callStatus = connError
    ? 'OFFLINE'
    : !joined
      ? 'LINKING'
      : peers.size === 0 || latency == null
        ? 'STANDBY'
        : latency >= 800
          ? 'CRITICAL'
          : latency >= 400
            ? 'POOR'
            : latency >= 200
              ? 'DEGRADED'
              : 'NOMINAL';
  const aliasSuggestions = aliases.map((a) => ({ label: `/${a.name}`, description: `alias → /${a.command}` }));

  // Active speaker = the peer with the strongest received audio (above noise).
  const activeSpeakerId = (() => {
    let best: { id: string; level: number } | null = null;
    for (const s of peerStats) {
      if (s.audioLevel > (best?.level ?? 0)) best = { id: s.id, level: s.audioLevel };
    }
    return best && best.level > 0.05 ? best.id : null;
  })();

  const chatPanel = (
    <ChatPanel
      messages={messages}
      mySocketId={socket.id ?? ''}
      onSend={sendChat}
      onClose={() => setChatOpen(false)}
    />
  );

  if (!nameReady) {
    const mediaReady = !!localStream || !!mediaError;
    return (
      <main id="main-content" className="namegate">
        <div className="namegate__card terminal-border">
          <div className="brand namegate__brand">
            <span className="brand__mark" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <rect x="2" y="5" width="13" height="14" rx="3" fill="var(--primary)" />
                <path d="M15 10.5 22 6.5v11l-7-4" fill="var(--success)" />
              </svg>
            </span>
            <span className="brand__name">Uplink</span>
          </div>
          <h1 className="namegate__title">Establish Uplink</h1>
          <p className="namegate__sub">Check your uplink, then connect.</p>

          <div className="gate__preview terminal-border">
            <video ref={previewVideoRef} className="gate__video" autoPlay playsInline muted />
            {(!cameraOn || !localStream) && (
              <div className="gate__placeholder">{cameraOn ? 'AWAITING_SIGNAL' : 'CAM_OFF'}</div>
            )}
            {cameraOn && localStream && <div className="gate__hud">PREVIEW</div>}
            {micOn && localStream && (
              <div className="gate__meter" aria-hidden="true">
                <div className="gate__meter-fill" style={{ transform: `scaleX(${micLevel})` }} />
              </div>
            )}
          </div>

          <div className="gate__toggles">
            <button
              type="button"
              className={`gate__toggle${micOn ? ' gate__toggle--on' : ''}`}
              onClick={() => void toggleMic()}
              disabled={!mediaReady}
              aria-pressed={micOn}
            >
              {micOn ? 'MIC ON' : 'MIC OFF'}
            </button>
            <button
              type="button"
              className={`gate__toggle${cameraOn ? ' gate__toggle--on' : ''}`}
              onClick={() => void toggleCamera()}
              disabled={!mediaReady}
              aria-pressed={cameraOn}
            >
              {cameraOn ? 'CAM ON' : 'CAM OFF'}
            </button>
          </div>

          {videoDevices.length > 1 && (
            <div className="gate__device">
              <label className="field-label">Camera</label>
              <select className="text-input gate__select" value={selectedVideoId ?? ''} onChange={(e) => void switchVideoDevice(e.target.value)}>
                {videoDevices.map((d) => (<option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${d.deviceId.slice(0, 6)}`}</option>))}
              </select>
            </div>
          )}
          {audioDevices.length > 1 && (
            <div className="gate__device">
              <label className="field-label">Microphone</label>
              <select className="text-input gate__select" value={selectedAudioId ?? ''} onChange={(e) => void switchAudioDevice(e.target.value)}>
                {audioDevices.map((d) => (<option key={d.deviceId} value={d.deviceId}>{d.label || `Mic ${d.deviceId.slice(0, 6)}`}</option>))}
              </select>
            </div>
          )}

          {mediaError && <p className="form-error" role="alert">{mediaError}</p>}

          <form onSubmit={submitName} className="namegate__form" noValidate>
            <label htmlFor="gate-name" className="field-label">Callsign</label>
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
            <button type="submit" className="btn btn-primary namegate__submit" disabled={!nameInput.trim() || !mediaReady}>
              Connect
            </button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <main id="main-content" className="call crt-flicker">
      <h1 className="visually-hidden">{`Uplink — ${roomId}`}</h1>
      <div className="scanlines" aria-hidden="true" />

      <header className="call__bar">
        <div className="call__bar-left">
          <span className="call__bar-icon" aria-hidden="true">
            <TerminalIcon />
          </span>
          <span className="call__bar-title glitch-text" data-text={`UPLINK_OS_v${__APP_VERSION__}`}>
            {`UPLINK_OS_v${__APP_VERSION__}`}
          </span>
        </div>
        <div className="call__bar-right">
          <div className="call__status-chip">
            <span className={`live-dot live-dot--${liveStatus.toLowerCase()}`} aria-hidden="true" />
            {liveStatus === 'LIVE' ? 'LIVE UPLINK' : liveStatus}
          </div>
          {!isDesktop && (
            <button
              type="button"
              className={`call__chat-toggle${chatOpen ? ' call__chat-toggle--active' : ''}`}
              onClick={() => {
                setChatOpen((v) => !v);
                setUnread(0);
              }}
              aria-label="Toggle chat"
              aria-pressed={chatOpen}
            >
              <ChatIcon />
              {unread > 0 && <span className="call__chat-badge">{unread}</span>}
            </button>
          )}
        </div>
      </header>

      <div className="call__body">
        <div className="call__main">
          <div className="call__grid-wrap">
            {!joined && !error && !connError && (
              <div className="call__status">Establishing uplink…</div>
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
              <div className={`call__peers${peerEntries.length === 0 ? ' call__peers--empty' : ''}`}>
                {peerEntries.length === 0 ? (
                  <span>// awaiting nodes…</span>
                ) : (
                  peerEntries.map(([id, p]) => (
                    <VideoTile
                      key={id}
                      stream={p.stream}
                      name={p.displayName}
                      micOn={p.micOn}
                      cameraOn={p.cameraOn}
                      screenShareOn={p.screenShareOn}
                      raisedHand={raisedHands.has(id)}
                      isHost={id === hostId}
                      isActiveSpeaker={activeSpeakerId === id}
                    />
                  ))
                )}
              </div>
            )}
            {joined && (
              <div className="call__self">
                <VideoTile
                  stream={selfTileStream}
                  name={`${displayName} (You)`}
                  isLocal
                  micOn={micOn}
                  cameraOn={cameraOn}
                  screenShareOn={screenSharing}
                  isSelfView
                  isHost={socket.id === hostId}
                  raisedHand={raisedHands.has(socket.id ?? '')}
                />
              </div>
            )}
          </div>

          <CommandBar onCommand={runCommand} aliases={aliasSuggestions} inputRef={commandInputRef} />

          <div className="mobile-controls" role="toolbar" aria-label="Call controls">
            <button
              type="button"
              className={`mc-btn${micOn ? ' mc-btn--on' : ''}`}
              onClick={() => void toggleMic()}
              aria-pressed={micOn}
              aria-label="Toggle microphone"
            >MIC</button>
            <button
              type="button"
              className={`mc-btn${cameraOn ? ' mc-btn--on' : ''}`}
              onClick={() => void toggleCamera()}
              aria-pressed={cameraOn}
              aria-label="Toggle camera"
            >CAM</button>
            <button
              type="button"
              className={`mc-btn${chatOpen ? ' mc-btn--on' : ''}`}
              onClick={() => {
                setChatOpen((v) => !v);
                setUnread(0);
              }}
              aria-pressed={chatOpen}
              aria-label="Toggle chat"
            >
              CHAT
              {unread > 0 && <sup className="mc-badge">{unread}</sup>}
            </button>
            <button
              type="button"
              className="mc-btn mc-btn--danger"
              onClick={() => setConfirmLeave(true)}
              aria-label="Leave call"
            >EXIT</button>
          </div>

          <footer className="call__foot">
            {recording && (
              <div className="rec-bar">
                <span className="rec-indicator">● REC</span>
                <button type="button" className={`rec-q${recQuality === 'high' ? ' rec-q--active' : ''}`} onClick={() => changeQuality('high')}>HIGH</button>
                <button type="button" className={`rec-q${recQuality === 'standard' ? ' rec-q--active' : ''}`} onClick={() => changeQuality('standard')}>STD</button>
                <button type="button" className={`rec-q${recQuality === 'low' ? ' rec-q--active' : ''}`} onClick={() => changeQuality('low')}>LOW</button>
                <button type="button" className="rec-stop" onClick={stopRecording}>STOP</button>
              </div>
            )}
            <span className="call__foot-room">ROOM: <strong translate="no">{roomId}</strong></span>
            <div className="call__foot-stats">
              <span>LATENCY: {latency == null ? '--' : `${latency}ms`}</span>
              <span>NODES: {nodeCount}</span>
              <span className={`stat--${callStatus.toLowerCase()}`}>STATUS: {callStatus}</span>
            </div>
          </footer>
        </div>

        {isDesktop && (
          <aside className="call__side">
            {chatPanel}
            <div className="syslogs terminal-border">
              <div className="syslogs__header">
                <span>SYS_LOGS</span>
              </div>
              <div className="syslogs__list" ref={sysLogsRef}>
                {logs.map((l) => (
                  <div
                    key={l.id}
                    className={`syslogs__item${l.level ? ` syslogs__item--${l.level}` : ''}`}
                  >
                    {l.text}
                  </div>
                ))}
              </div>
            </div>
          </aside>
        )}
      </div>

      {!isDesktop && chatOpen && chatPanel}

      {joined && diagOpen && (
        <div className="diag terminal-border" role="dialog" aria-label="Network diagnostics">
          <div className="diag__header">
            <span>NET_CONSOLE</span>
            <button type="button" className="diag__close" onClick={() => setDiagOpen(false)} aria-label="Close diagnostics">✕</button>
          </div>
          <div className="diag__body">
            {peerStats.length === 0 ? (
              <div className="diag__empty">// no peer links</div>
            ) : (
              peerStats.map((s) => (
                <div key={s.id} className="diag__row">
                  <span className="diag__node">{peersRef.current.get(s.id)?.displayName ?? s.id.slice(0, 6)}</span>
                  <span>RTT {s.rttMs == null ? '--' : `${s.rttMs}ms`}</span>
                  <span>LOSS {s.lossPct}%</span>
                  <span>JIT {s.jitterMs == null ? '--' : `${s.jitterMs}ms`}</span>
                  <span>IN {s.bitrateInKbps}k</span>
                  <span>OUT {s.bitrateOutKbps}k</span>
                  <span>{s.codec ?? '--'}</span>
                  <span className={`diag__relay diag__relay--${s.relay}`}>{s.relay}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {deviceOpen && (
        <div className="device-panel terminal-border" role="dialog" aria-label="Device settings">
          <div className="device-panel__header">
            <span>DEVICE_SETTINGS</span>
            <button type="button" className="diag__close" onClick={() => setDeviceOpen(false)} aria-label="Close device settings">✕</button>
          </div>
          <div className="device-panel__body">
            {videoDevices.length > 1 && (
              <label className="field-label">Camera
                <select className="text-input" value={selectedVideoId ?? ''} onChange={(e) => void switchVideoDevice(e.target.value)}>
                  {videoDevices.map((d) => (<option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${d.deviceId.slice(0, 6)}`}</option>))}
                </select>
              </label>
            )}
            {audioDevices.length > 1 && (
              <label className="field-label">Microphone
                <select className="text-input" value={selectedAudioId ?? ''} onChange={(e) => void switchAudioDevice(e.target.value)}>
                  {audioDevices.map((d) => (<option key={d.deviceId} value={d.deviceId}>{d.label || `Mic ${d.deviceId.slice(0, 6)}`}</option>))}
                </select>
              </label>
            )}
          </div>
        </div>
      )}

      {rosterOpen && (
        <div className="roster-panel terminal-border" role="dialog" aria-label="Participants">
          <div className="roster-panel__header">
            <span>PEOPLE ({nodeCount})</span>
            <button type="button" className="diag__close" onClick={() => setRosterOpen(false)} aria-label="Close roster">✕</button>
          </div>
          <div className="roster-panel__body">
            <div className={`roster__row${activeSpeakerId === socket.id ? ' roster__row--speaking' : ''}`}>
              <span className="roster__name">{displayName} (You)</span>
              {socket.id === hostId && <span className="roster__badge roster__badge--host">HOST</span>}
              <span className="roster__status">{micOn ? 'MIC:ON' : 'MIC:OFF'} {cameraOn ? 'CAM:ON' : 'CAM:OFF'}{screenSharing ? ' SHARE' : ''}{raisedHands.has(socket.id ?? '') ? ' ✋' : ''}</span>
            </div>
            {peerEntries.map(([id, p]) => (
              <div key={id} className={`roster__row${activeSpeakerId === id ? ' roster__row--speaking' : ''}`}>
                <span className="roster__name">{p.displayName}</span>
                {id === hostId && <span className="roster__badge roster__badge--host">HOST</span>}
                <span className="roster__status">{p.micOn ? 'MIC:ON' : 'MIC:OFF'} {p.cameraOn ? 'CAM:ON' : 'CAM:OFF'}{p.screenShareOn ? ' SHARE' : ''}{raisedHands.has(id) ? ' ✋' : ''}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {toast && (
        <div className="toast" role="status" aria-live="polite" key={toast.id}>
          {toast.text}
        </div>
      )}

      <ConfirmDialog
        open={confirmLeave}
        title="Leave Session?"
        message="You'll be disconnected from this call. You can rejoin with the same link."
        confirmLabel="Leave"
        cancelLabel="Stay"
        onConfirm={leaveRoom}
        onCancel={() => setConfirmLeave(false)}
      />
    </main>
  );
}

/* --- App bar icons --- */
function TerminalIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" />
      <path d="M7 9l3 3-3 3" />
      <line x1="13" y1="15" x2="17" y2="15" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 11.5a8.38 8.38 0 0 1-9 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.2A8.5 8.5 0 0 1 12 3a8.38 8.38 0 0 1 9 8.5z" />
    </svg>
  );
}