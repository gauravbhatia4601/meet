import { useEffect, useRef } from 'react';

interface VideoTileProps {
  stream?: MediaStream | null;
  name: string;
  isLocal?: boolean;
  micOn: boolean;
  cameraOn: boolean;
  screenShareOn?: boolean;
  raisedHand?: boolean;
  isSelfView?: boolean;
}

// Deterministic avatar background derived from the name, so each participant
// gets a stable, distinct color.
const AVATAR_COLORS = [
  '#1a73e8', '#188038', '#e37400', '#d93025',
  '#8430ce', '#00695c', '#c2185b', '#3f51b5',
];

function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export default function VideoTile({
  stream,
  name,
  isLocal = false,
  micOn,
  cameraOn,
  screenShareOn = false,
  raisedHand = false,
  isSelfView = false,
}: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (stream && el.srcObject !== stream) {
      el.srcObject = stream;
    }
    return () => {
      if (el) el.srcObject = null;
    };
  }, [stream]);

  const showAvatar = !cameraOn || !stream;

  return (
    <div className="tile">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={isLocal}
        className="tile__video"
        style={{ transform: isSelfView ? 'scaleX(-1)' : undefined }}
        aria-label={cameraOn && stream ? name : undefined}
        aria-hidden={cameraOn && stream ? undefined : true}
      />

      {showAvatar && (
        <div
          className="tile__avatar"
          style={{ background: avatarColor(name) }}
          aria-hidden="true"
        >
          {name.charAt(0).toUpperCase() || '?'}
        </div>
      )}

      {screenShareOn && <span className="tile__badge tile__badge--share">Presenting</span>}

      {raisedHand && (
        <span className="tile__badge tile__badge--hand" aria-label="Hand raised">
          ✋
        </span>
      )}

      <div className="tile__footer">
        <span className="tile__name">{name}</span>
        <span className="tile__icons">
          {!micOn && <MicOffIcon />}
          {!cameraOn && <CamOffIcon />}
        </span>
      </div>
    </div>
  );
}

function MicOffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Z" fill="#ff5252" />
      <path d="M17.7 11a5.7 5.7 0 0 1-1.3 3.6M5.6 11a6.4 6.4 0 0 0 9.7 5.4M12 17.5V21" stroke="#ff5252" strokeWidth="1.6" strokeLinecap="round" />
      <path d="m4 4 16 16" stroke="#ff5252" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function CamOffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <rect x="3" y="6" width="13" height="12" rx="2" fill="#ff5252" />
      <path d="M16 10 22 7v10l-6-3" fill="#ff5252" />
      <path d="m4 4 16 16" stroke="#ff5252" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
