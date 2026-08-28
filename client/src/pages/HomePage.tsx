import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useSocket } from '../hooks/useSocket';
import { normalizeRoomId, isValidRoomId } from '../lib/roomCode';

export default function HomePage() {
  const socket = useSocket();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [latency, setLatency] = useState<number | null>(null);
  const [online, setOnline] = useState(false);
  const [copied, setCopied] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);

  // Move focus to the first error so keyboard and screen-reader users find it.
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  // Measure round-trip time to the signaling server for the live HUD readout.
  useEffect(() => {
    let active = true;
    const measure = () => {
      const start = Date.now();
      let done = false;
      const fail = window.setTimeout(() => {
        if (!done && active) {
          done = true;
          setLatency(null);
        }
      }, 3000);
      socket.emit('latency:probe', () => {
        if (done) return;
        done = true;
        window.clearTimeout(fail);
        if (active) setLatency(Date.now() - start);
      });
    };
    measure();
    const id = window.setInterval(measure, 5000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [socket]);

  // Track real connection state for the dynamic STATUS readout.
  useEffect(() => {
    const onConnect = () => setOnline(true);
    const onDisconnect = () => setOnline(false);
    const onConnectError = () => setOnline(false);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
    };
  }, [socket]);

  function createRoom() {
    setError('');
    setCreating(true);
    socket.emit('create-room', (res) => {
      setCreating(false);
      if (res.ok && res.roomId) {
        navigate(`/room/${res.roomId}`);
      } else {
        setError(res.error ?? 'Could not create meeting. Please try again.');
      }
    });
  }

  function joinRoom(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const roomId = normalizeRoomId(code);
    if (!roomId) {
      setError('Please enter a meeting code.');
      return;
    }
    if (!isValidRoomId(roomId)) {
      setError('That code looks invalid. Format is like “abc-defg-hij”.');
      return;
    }
    navigate(`/room/${roomId}`);
  }

  function shareApp() {
    const url = window.location.origin;
    if (navigator.share) {
      navigator
        .share({
          title: 'Uplink // Secure Signal',
          text: 'Secure, real-time, peer-to-peer video meetings in your browser.',
          url,
        })
        .catch(() => {});
    } else {
      navigator.clipboard?.writeText(url).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      }).catch(() => {});
    }
  }

  return (
    <div className="home">
      <div className="scanline" aria-hidden="true" />

      <nav className="home__nav" aria-label="Primary">
        <div className="home__brand">Uplink</div>
        <div className="home__nav-actions">
          <button type="button" className="home__icon-btn" onClick={shareApp} aria-label="Share Uplink" title="Share Uplink">
            <ShareIcon />
          </button>
          <Link to="/about" className="home__icon-btn" aria-label="How it works" title="How it works">
            <HelpIcon />
          </Link>
        </div>
      </nav>

      <main id="main-content" className="home__body">
        <div className="home__content">
          <div className="home__hero">
            <h1 className="home__title">UPLINK // SECURE_SIGNAL</h1>
            <p className="home__subtitle">
              Premium video meetings for everyone. Secure, real-time, peer-to-peer video calls.
            </p>
          </div>

          <div className="home__card terminal-border terminal-bg">
            <div className="home__card-title">
              &gt; ENTER_MEETING_CODE<span className="blink" aria-hidden="true">_</span>
            </div>
            <form onSubmit={joinRoom} className="home__form" noValidate>
              <div className="home__field">
                <span className="home__field-prefix" aria-hidden="true">#</span>
                <input
                  id="meeting-code"
                  name="meeting-code"
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value);
                    setError('');
                  }}
                  placeholder="XXXX-XXXX-XXXX"
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Meeting Code"
                  className="terminal-input home__input"
                />
              </div>

              {error && (
                <p className="form-error" role="alert" ref={errorRef} tabIndex={-1}>
                  {error}
                </p>
              )}

              <button type="submit" className="terminal-button home__submit">
                INITIATE_LINK
              </button>
            </form>

            <div className="home__alt">
              <button
                type="button"
                onClick={createRoom}
                disabled={creating}
                className="home__alt-link"
              >
                {creating && <span className="spinner" aria-hidden="true" />}
                {creating ? 'INITIATING…' : 'OR START_NEW_SESSION'}
              </button>
            </div>
          </div>
        </div>
      </main>

      <footer className="home__footer">
        <div className="home__footer-brand">© 2024 UPLINK SYSTEMS</div>
        <div className="home__footer-stats">
          <span>LATENCY: {latency == null ? '--' : `${latency}ms`}</span>
          <span className={online ? 'stat--ok' : 'stat--off'}>
            STATUS: {online ? 'ONLINE' : 'OFFLINE'}
          </span>
        </div>
      </footer>

      {copied && (
        <div className="toast" role="status" aria-live="polite">Link copied</div>
      )}
    </div>
  );
}

/* --- Nav icon (stroke-based, currentColor) --- */
function HelpIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  );
}