/**
 * MeetingView Component
 * 
 * Main meeting interface with participants, controls, and chat
 */

import React, { useState, useMemo } from 'react';
import { Clock, Users as UsersIcon, Copy, Check, ExternalLink } from 'lucide-react';
import { ParticipantTile, ControlBar, ChatPanel, ParticipantsList, InfoPanel } from '../../components/meeting/index.js';
import { useMeeting, useMedia, useParticipants, useChat } from '../../hooks/index.js';
import { useMeetingStore } from '../../store/index.js';
import { AppView } from '../../types/index.js';

interface MeetingViewProps {
  roomCode: string;
  onNavigate: (view: AppView) => void;
}

/**
 * Format time as MM:SS
 */
const formatTime = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

export const MeetingView: React.FC<MeetingViewProps> = ({ roomCode, onNavigate }) => {
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isParticipantsOpen, setIsParticipantsOpen] = useState(false);
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [copied, setCopied] = useState(false);
  
  // Generate meeting URL
  const meetingUrl = `${window.location.origin}${window.location.pathname}?room=${roomCode}`;
  
  // Handle copy meeting link
  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(meetingUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };
  
  // Handle click to open link
  const handleOpenLink = () => {
    window.open(meetingUrl, '_blank');
  };
  
  // Determine which sidebar is currently open
  const openSidebar = useMemo(() => {
    if (isChatOpen) return 'chat';
    if (isParticipantsOpen) return 'participants';
    if (isInfoOpen) return 'info';
    return null;
  }, [isChatOpen, isParticipantsOpen, isInfoOpen]);
  
  // Handle sidebar toggles - close others when opening a new one
  const handleToggleChat = () => {
    if (isChatOpen) {
      setIsChatOpen(false);
    } else {
      setIsParticipantsOpen(false);
      setIsInfoOpen(false);
      setIsChatOpen(true);
    }
  };
  
  const handleToggleParticipants = () => {
    if (isParticipantsOpen) {
      setIsParticipantsOpen(false);
    } else {
      setIsChatOpen(false);
      setIsInfoOpen(false);
      setIsParticipantsOpen(true);
    }
  };
  
  const handleToggleInfo = () => {
    if (isInfoOpen) {
      setIsInfoOpen(false);
    } else {
      setIsChatOpen(false);
      setIsParticipantsOpen(false);
      setIsInfoOpen(true);
    }
  };

  // Hooks
  // Don't auto-connect here - App.tsx already handles joining
  const meeting = useMeeting({ autoConnect: false });
  const media = useMedia({ autoStart: false }); // Stream should already be initialized from lobby
  const participants = useParticipants();
  const chat = useChat();

  // Ensure stream is initialized and local participant is updated
  React.useEffect(() => {
    const ensureStream = async () => {
      // Get current stream state
      const currentStream = media.localStream;
      
      if (!currentStream) {
        try {
          console.log('[MeetingView] No stream found, initializing...');
          await media.initializeStream();
          // Wait for stream to be set
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (error) {
          console.error('[MeetingView] Failed to initialize stream:', error);
        }
      } else {
        console.log('[MeetingView] Stream already exists');
      }
    };
    
    ensureStream();
  }, []); // Only run once on mount

  // Update local participant's stream when media stream changes
  // Use ref to prevent infinite loops
  const updateParticipant = useMeetingStore(state => state.updateParticipant);
  const lastStreamRef = React.useRef<MediaStream | null>(null);
  const lastCamStateRef = React.useRef<boolean | null>(null);
  const lastMicStateRef = React.useRef<boolean | null>(null);
  
  React.useEffect(() => {
    const local = participants.localParticipant;
    const stream = media.localStream;
    
    // Only update if something actually changed
    const streamChanged = stream !== lastStreamRef.current;
    const camChanged = media.isCamOn !== lastCamStateRef.current;
    const micChanged = media.isMicOn !== lastMicStateRef.current;
    
    if (stream && local && (streamChanged || camChanged || micChanged)) {
      // Check if the participant actually needs updating
      const needsUpdate = 
        local.stream !== stream ||
        local.videoEnabled !== media.isCamOn ||
        local.audioEnabled !== media.isMicOn;
      
      if (needsUpdate) {
        console.log('[MeetingView] Updating local participant with stream');
        updateParticipant(local.peerId, {
          stream: stream,
          videoEnabled: media.isCamOn,
          audioEnabled: media.isMicOn
        });
        
        // Update refs
        lastStreamRef.current = stream;
        lastCamStateRef.current = media.isCamOn;
        lastMicStateRef.current = media.isMicOn;
      }
    } else if (!stream && local) {
      console.warn('[MeetingView] No stream available for local participant');
    }
    
    // Update refs even if we don't update (for initial state tracking)
    if (stream) lastStreamRef.current = stream;
    if (lastCamStateRef.current === null) lastCamStateRef.current = media.isCamOn;
    if (lastMicStateRef.current === null) lastMicStateRef.current = media.isMicOn;
  }, [media.localStream, media.isCamOn, media.isMicOn, participants.localParticipant?.peerId, updateParticipant]);

  // Timer
  React.useEffect(() => {
    const interval = setInterval(() => {
      setElapsedTime((prev) => prev + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  // Get layout participants (remote first, then local)
  const layoutParticipants = useMemo(() => {
    const remote = participants.remoteParticipants;
    const local = participants.localParticipant;
    return local ? [...remote, local] : remote;
  }, [participants.remoteParticipants, participants.localParticipant]);

  // Determine layout based on participant count
  const participantCount = participants.participantCount;
  const isTwoPersonLayout = participantCount === 2;
  const isOnePersonLayout = participantCount === 1;

  /**
   * Handle leave meeting
   */
  const handleLeave = () => {
    meeting.leaveRoom();
    media.stopStream();
    onNavigate(AppView.LANDING);
  };

  /**
   * Handle toggle screen share
   */
  const handleToggleScreenShare = async () => {
    if (media.isScreenSharing) {
      await media.stopScreenShare();
    } else {
      await media.startScreenShare();
    }
  };

  return (
    <div className="h-screen bg-black flex flex-col relative">
      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden pb-24">
        {/* Participants Grid */}
        <div className="flex-1 relative overflow-hidden">
          {isTwoPersonLayout ? (
            // Google Meet style: Remote large, local small overlay
            <div className="absolute inset-0">
              {/* Remote participant - large and centered, fills available space with padding */}
              {layoutParticipants
                .filter((p) => !p.isLocal)
                .map((participant) => (
                  <div
                    key={participant.peerId}
                    className="absolute inset-0 p-4 md:p-6"
                  >
                    <ParticipantTile
                      participant={participant}
                      isLocal={false}
                      isLarge={true}
                    />
                  </div>
                ))}

              {/* Local participant - small overlay in bottom-right */}
              {layoutParticipants
                .filter((p) => p.isLocal)
                .map((participant) => (
                  <div
                    key={participant.peerId}
                    className="absolute right-4 md:right-6 w-[200px] h-[150px] md:w-[256px] md:h-[192px] z-30 rounded-xl overflow-hidden shadow-2xl border-2 border-white/20"
                    style={{ bottom: '100px' }} // Position above control bar (control bar ~80px + spacing)
                  >
                    <ParticipantTile
                      participant={participant}
                      isLocal={true}
                      isLarge={false}
                    />
                  </div>
                ))}
            </div>
          ) : (
            // Grid layout for 1 or 3+ participants
            <div
              className={`grid gap-4 md:gap-6 h-full ${
                isOnePersonLayout
                  ? 'grid-cols-1'
                  : participantCount === 3
                  ? 'grid-cols-2'
                  : participantCount === 4
                  ? 'grid-cols-2'
                  : 'grid-cols-2 lg:grid-cols-3'
              }`}
            >
              {layoutParticipants.map((participant) => (
                <ParticipantTile
                  key={participant.peerId}
                  participant={participant}
                  isLocal={participant.isLocal}
                  isLarge={isOnePersonLayout}
                />
              ))}
            </div>
          )}
        </div>

        {/* Side Panels - Animated */}
        <div
          className={`fixed right-0 top-0 bottom-24 z-50 w-80 bg-gray-900 border-l border-white/10 rounded-l-xl overflow-hidden shadow-2xl transition-transform duration-300 ease-in-out ${
            openSidebar ? 'translate-x-0' : 'translate-x-full'
          }`}
        >
          <div className="h-full m-4 mr-0 rounded-xl overflow-hidden">
            {isChatOpen && (
              <ChatPanel
                messages={chat.messages}
                onSendMessage={chat.sendMessage}
                onClose={handleToggleChat}
                className="h-full"
              />
            )}
            {isParticipantsOpen && (
              <ParticipantsList
                participants={participants.remoteParticipants}
                localParticipant={participants.localParticipant}
                onClose={handleToggleParticipants}
                className="h-full"
              />
            )}
            {isInfoOpen && (
              <InfoPanel
                roomCode={roomCode}
                onClose={handleToggleInfo}
                className="h-full"
              />
            )}
          </div>
        </div>
      </div>

      {/* Control Bar */}
      <div className="absolute bottom-0 left-0 right-0 z-40 bg-black/80 backdrop-blur-lg border-t border-white/10 p-4">
        <ControlBar
          isMicOn={media.isMicOn}
          isCamOn={media.isCamOn}
          isScreenSharing={media.isScreenSharing}
          onToggleMic={media.toggleMicrophone}
          onToggleCam={media.toggleCamera}
          onToggleScreenShare={handleToggleScreenShare}
          onLeave={handleLeave}
          onToggleChat={handleToggleChat}
          onToggleParticipants={handleToggleParticipants}
          onToggleInfo={handleToggleInfo}
          showChat={isChatOpen}
          showParticipants={isParticipantsOpen}
          showInfo={isInfoOpen}
          participantCount={participantCount}
          className="w-full"
        />
        
        {/* Left: Time, Participants, and Meeting Link */}
        <div className="absolute left-4 bottom-4 flex items-center gap-4">
          <div className="flex items-center gap-2 text-white">
            <Clock className="w-4 h-4" />
            <span className="text-sm font-medium">{formatTime(elapsedTime)}</span>
          </div>
          <div className="h-4 w-px bg-white/20" />
          <div className="flex items-center gap-2 text-white">
            <UsersIcon className="w-4 h-4" />
            <span className="text-sm font-medium">{participantCount}</span>
          </div>
          <div className="h-4 w-px bg-white/20" />
          {/* Meeting Link - Clickable */}
          <div className="flex items-center gap-2 group">
            <a
              href={meetingUrl}
              onClick={(e) => {
                e.preventDefault();
                handleOpenLink();
              }}
              className="flex items-center gap-2 text-white hover:text-blue-400 transition-colors cursor-pointer"
              title="Click to open meeting link"
            >
              <span className="text-sm font-mono max-w-[200px] md:max-w-[300px] truncate">
                {meetingUrl}
              </span>
              <ExternalLink className="w-3.5 h-3.5 opacity-0 group-hover:opacity-100 transition-opacity" />
            </a>
            <button
              onClick={handleCopyLink}
              className="p-1.5 rounded hover:bg-white/10 transition-colors text-white hover:text-blue-400"
              title="Copy meeting link"
            >
              {copied ? (
                <Check className="w-3.5 h-3.5 text-green-400" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

