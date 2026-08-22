interface ControlsBarProps {
  micOn: boolean;
  cameraOn: boolean;
  screenSharing: boolean;
  chatOpen: boolean;
  onToggleMic: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onToggleChat: () => void;
  onLeave: () => void;
}

export default function ControlsBar({
  micOn, cameraOn, screenSharing, chatOpen,
  onToggleMic, onToggleCamera, onToggleScreenShare, onToggleChat, onLeave,
}: ControlsBarProps) {
  return (
    <div className="controls">
      <ControlBtn label={micOn ? 'Mute' : 'Unmute'} active={micOn} onClick={onToggleMic}>
        {micOn ? <MicOn /> : <MicOff />}
      </ControlBtn>

      <ControlBtn label={cameraOn ? 'Stop Video' : 'Start Video'} active={cameraOn} onClick={onToggleCamera}>
        {cameraOn ? <CamOn /> : <CamOff />}
      </ControlBtn>

      <ControlBtn label={screenSharing ? 'Stop Presenting' : 'Present'} active={screenSharing} onClick={onToggleScreenShare}>
        <ScreenShare />
      </ControlBtn>

      <ControlBtn label={chatOpen ? 'Close Chat' : 'Chat'} active={chatOpen} onClick={onToggleChat}>
        <ChatIcon />
      </ControlBtn>

      <button onClick={onLeave} className="controls__leave btn btn-danger">
        <LeaveIcon />
        Leave
      </button>
    </div>
  );
}

function ControlBtn({
  label, active, onClick, children,
}: {
  label: string; active: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <div className="control">
      <button
        onClick={onClick}
        title={label}
        aria-label={label}
        className={`control__btn${active ? ' control__btn--active' : ''}`}
      >
        {children}
      </button>
      <span className="control__label">{label}</span>
    </div>
  );
}

/* --- Icons (stroke-based, currentColor) --- */
function MicOn() { return <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Zm5.7-3a5.7 5.7 0 0 1-11.4 0H5a7 7 0 0 0 6 6.9V21h2v-3.1a7 7 0 0 0 6-6.9h-1.3Z"/></svg>; }
function MicOff() { return <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Zm5.7-3a5.7 5.7 0 0 1-1.3 3.6l-1.2-1.2a4 4 0 0 0 .9-2.4h1.6Zm-9.2 0a4 4 0 0 0 5.4 3.6l-1.3-1.3a2 2 0 0 1-2.5-2.5l-1.3-1.3a4 4 0 0 0-.3 1.5Zm8.9 8.3-1.4-1.4A7 7 0 0 1 5 11H6.6a5.4 5.4 0 0 0 .9 2.9l1.2-1.2a4 4 0 0 1-1.4-3H12l-2-2H7a7 7 0 0 1 6-3.9v2a4.6 4.6 0 0 0-.6 1l2 2c.1-.3.2-.6.2-1h1.6A5.7 5.7 0 0 1 12 8.2L14 10.2h.3v1.8h1.6a7 7 0 0 1-.6 2.9l1.4 1.4a7 7 0 0 0 1.1-3.7h1.6a8.6 8.6 0 0 1-1 4.2ZM4.3 3.3l16 16L22 17.7 6.6 2.3a9 9 0 0 1 5.3-1.3A8.6 8.6 0 0 1 20.4 7H18a6.8 6.8 0 0 0-6.3-3.8c-1 0-1.9.2-2.7.6L6.3 1.2a9 9 0 0 1 4.5-1.2A9 9 0 0 1 22 11a8.6 8.6 0 0 1-1.6 4.9l1.4 1.4A10 10 0 0 0 22.4 9 10.6 10.6 0 0 0 11 0 10 10 0 0 0 4.3 3.3Z" transform="scale(0.9) translate(1 1)"/></svg>; }
function CamOn() { return <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M16 7a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h11Zm6 2v6a1 1 0 0 1-1.5.9L17 14.2V9.8l3.5-1.7A1 1 0 0 1 22 9Z"/></svg>; }
function CamOff() { return <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M16 7a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h11Zm6 2v6a1 1 0 0 1-1.5.9L17 14.2V9.8l3.5-1.7A1 1 0 0 1 22 9ZM6 11h2v-1H6v1Z"/></svg>; }
function ScreenShare() { return <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M9 20h6M12 17v3M8 10l2 2-2 2M13 10l3 2-3 2" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function ChatIcon() { return <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3C6.5 3 2 6.6 2 11c0 2.3 1.1 4.4 3 5.9V21l3.8-2.1c1 .2 2 .3 3.2.3 5.5 0 10-3.6 10-8.2S17.5 3 12 3Zm-4 8a1.2 1.2 0 1 1 0-2.4A1.2 1.2 0 0 1 8 11Zm4 0a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4Zm4 0a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4Z"/></svg>; }
function LeaveIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M11 4h-1a2 2 0 0 0-2 2v1h2V6h2v12h-2v-1H8v1a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Zm6.5 4.5 1.4 1.4 1.6 1.6H10v2h10.5l-1.6 1.6-1.4 1.4 1.4 1.4 2.5-2.5a2 2 0 0 0 0-2.8l-2.5-2.5-1.4 1.4Z" transform="scale(0.8) translate(3 2.5)"/></svg>; }
