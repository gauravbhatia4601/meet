import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSocket } from '../hooks/useSocket';
import { normalizeRoomId, isValidRoomId } from '../lib/roomCode';

export default function HomePage() {
  const socket = useSocket();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [name, setName] = useState(() => localStorage.getItem('meet_name') ?? '');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  // Persist the display name so it survives reloads and room changes.
  useEffect(() => {
    if (name.trim()) localStorage.setItem('meet_name', name.trim());
  }, [name]);

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
      setError('That code looks invalid. Format is like "abc-defg-hij".');
      return;
    }
    navigate(`/room/${roomId}`);
  }

  return (
    <div className="home">
      <header className="home__header">
        <div className="home__header-inner">
          <div className="brand">
            <span className="brand__mark" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <rect x="2" y="5" width="13" height="14" rx="3" fill="var(--primary)" />
                <path d="M15 10.5 22 6.5v11l-7-4" fill="var(--success)" />
              </svg>
            </span>
            <span className="brand__name">Meet Clone</span>
          </div>
        </div>
      </header>

      <main className="home__body">
        <section className="home__intro">
          <span className="home__eyebrow">WebRTC video calls</span>
          <h1>Premium video meetings for everyone</h1>
          <p className="home__sub">
            Secure, real-time, peer-to-peer video calls — right in your browser. No
            plugins, no installs, no waiting.
          </p>
          <ul className="home__features">
            <li>
              <span className="home__feature-icon" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M9 20h6M12 17v3" strokeLinecap="round" /></svg>
              </span>
              High-quality video &amp; audio
            </li>
            <li>
              <span className="home__feature-icon" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="8" r="4" /><path d="M4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5" strokeLinecap="round" /></svg>
              </span>
              Live participant grid
            </li>
            <li>
              <span className="home__feature-icon" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21 12a9 9 0 1 1-3-6.7" strokeLinecap="round" /><path d="m9 12 2 2 4-4" strokeLinecap="round" strokeLinejoin="round" /><path d="M21 3v4h-4" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </span>
              In-call chat &amp; screen sharing
            </li>
          </ul>
        </section>

        <section className="home__card">
          <h2 className="home__card-title">Ready to join?</h2>
          <form onSubmit={joinRoom} className="home__form" noValidate>
            <label htmlFor="meeting-code" className="field-label">
              Meeting code
            </label>
            <input
              id="meeting-code"
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setError('');
              }}
              placeholder="abc-defg-hij"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              className="text-input"
            />

            <label htmlFor="display-name" className="field-label">
              Your name
            </label>
            <input
              id="display-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jane Doe"
              autoComplete="name"
              className="text-input"
            />

            {error && <p className="form-error" role="alert">{error}</p>}

            <div className="home__actions">
              <button type="submit" className="btn btn-primary">Join</button>
              <button
                type="button"
                onClick={createRoom}
                disabled={creating}
                className="btn btn-secondary"
              >
                {creating ? 'Creating…' : 'New meeting'}
              </button>
            </div>
          </form>
        </section>
      </main>

      <footer className="home__footer">
        <span>Built with WebRTC &amp; Socket.IO</span>
      </footer>
    </div>
  );
}
