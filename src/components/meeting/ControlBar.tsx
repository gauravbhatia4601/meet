/**
 * ControlBar Component
 * 
 * Meeting controls (mic, camera, share screen, leave, etc.)
 */

import React from 'react';
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  PhoneOff,
  Monitor,
  MessageSquare,
  Users,
  Settings,
  Info
} from 'lucide-react';
import { Tooltip } from '../shared/Tooltip.js';

interface ControlBarProps {
  isMicOn: boolean;
  isCamOn: boolean;
  isScreenSharing: boolean;
  onToggleMic: () => void;
  onToggleCam: () => void;
  onToggleScreenShare: () => void;
  onLeave: () => void;
  onToggleChat?: () => void;
  onToggleParticipants?: () => void;
  onToggleInfo?: () => void;
  showChat?: boolean;
  showParticipants?: boolean;
  showInfo?: boolean;
  participantCount?: number;
  className?: string;
}

export const ControlBar: React.FC<ControlBarProps> = ({
  isMicOn,
  isCamOn,
  isScreenSharing,
  onToggleMic,
  onToggleCam,
  onToggleScreenShare,
  onLeave,
  onToggleChat,
  onToggleParticipants,
  onToggleInfo,
  showChat = false,
  showParticipants = false,
  showInfo = false,
  participantCount = 0,
  className = ''
}) => {
  return (
    <div className={`flex items-center justify-between w-full ${className}`}>
      {/* Left spacer for time/code */}
      <div className="w-48" />
      
      {/* Center: Main Controls (Mic, Camera, Screen Share, Leave) */}
      <div className="flex items-center justify-center gap-2 flex-1">
      {/* Microphone Toggle */}
      <Tooltip text={isMicOn ? 'Turn off microphone' : 'Turn on microphone'}>
        <button
          onClick={onToggleMic}
          className={`p-3 rounded-full transition-colors ${
            isMicOn
              ? 'bg-gray-700 hover:bg-gray-600 text-white'
              : 'bg-red-500 hover:bg-red-600 text-white'
          }`}
        >
          {isMicOn ? (
            <Mic className="w-5 h-5" />
          ) : (
            <MicOff className="w-5 h-5" />
          )}
        </button>
      </Tooltip>

      {/* Camera Toggle */}
      <Tooltip text={isCamOn ? 'Turn off camera' : 'Turn on camera'}>
        <button
          onClick={onToggleCam}
          className={`p-3 rounded-full transition-colors ${
            isCamOn
              ? 'bg-gray-700 hover:bg-gray-600 text-white'
              : 'bg-red-500 hover:bg-red-600 text-white'
          }`}
        >
          {isCamOn ? (
            <Video className="w-5 h-5" />
          ) : (
            <VideoOff className="w-5 h-5" />
          )}
        </button>
      </Tooltip>

      {/* Screen Share Toggle */}
      <Tooltip text={isScreenSharing ? 'Stop sharing' : 'Share screen'}>
        <button
          onClick={onToggleScreenShare}
          className={`p-3 rounded-full transition-colors ${
            isScreenSharing
              ? 'bg-blue-500 hover:bg-blue-600 text-white'
              : 'bg-gray-700 hover:bg-gray-600 text-white'
          }`}
        >
          <Monitor className="w-5 h-5" />
        </button>
      </Tooltip>

      {/* Leave Button */}
      <Tooltip text="Leave meeting">
        <button
          onClick={onLeave}
          className="p-3 rounded-full bg-red-500 hover:bg-red-600 text-white transition-colors"
        >
          <PhoneOff className="w-5 h-5" />
        </button>
      </Tooltip>
      </div>

      {/* Right: Chat, Participants, Info */}
      <div className="flex items-center gap-2">
        {/* Chat Toggle */}
        {onToggleChat && (
          <Tooltip text={showChat ? 'Hide chat' : 'Show chat'}>
            <button
              onClick={onToggleChat}
              className={`p-3 rounded-full transition-colors ${
                showChat
                  ? 'bg-blue-500 hover:bg-blue-600 text-white'
                  : 'bg-gray-700 hover:bg-gray-600 text-white'
              }`}
            >
              <MessageSquare className="w-5 h-5" />
            </button>
          </Tooltip>
        )}

        {/* Participants Toggle */}
        {onToggleParticipants && (
          <Tooltip text={showParticipants ? 'Hide participants' : 'Show participants'}>
            <button
              onClick={onToggleParticipants}
              className={`p-3 rounded-full transition-colors relative ${
                showParticipants
                  ? 'bg-blue-500 hover:bg-blue-600 text-white'
                  : 'bg-gray-700 hover:bg-gray-600 text-white'
              }`}
            >
              <Users className="w-5 h-5" />
              {participantCount > 0 && (
                <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
                  {participantCount}
                </span>
              )}
            </button>
          </Tooltip>
        )}

        {/* Info Toggle */}
        {onToggleInfo && (
          <Tooltip text={showInfo ? 'Hide meeting info' : 'Show meeting info'}>
            <button
              onClick={onToggleInfo}
              className={`p-3 rounded-full transition-colors ${
                showInfo
                  ? 'bg-blue-500 hover:bg-blue-600 text-white'
                  : 'bg-gray-700 hover:bg-gray-600 text-white'
              }`}
            >
              <Info className="w-5 h-5" />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
};

