import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSocket } from '../hooks/useSocket';
import { normalizeRoomId, isValidRoomId } from '../lib/roomCode';

export default function HomePage() {
  const socket = useSocket();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);

  // Move focus to the first error so keyboard and screen-reader users find it.
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

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

  return (
    <div className="home">
      <div className="scanline" aria-hidden="true" />

      <nav className="home__nav" aria-label="Primary">
        <div className="home__brand">Uplink</div>
        <div className="home__nav-actions">
          <button type="button" className="home__icon-btn" aria-label="Help" title="Help">
            <HelpIcon />
          </button>
          <button type="button" className="home__icon-btn" aria-label="Settings" title="Settings">
            <SettingsIcon />
          </button>
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
        <div className="home__footer-stats" aria-hidden="true">
          <span>LATENCY: 12ms</span>
          <span>ENCRYPTION: AES-256-GCM</span>
          <span>STATUS: NOMINAL</span>
        </div>
      </footer>
    </div>
  );
}

/* --- Nav icons (stroke-based, currentColor) --- */
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

function SettingsIcon() {
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
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}