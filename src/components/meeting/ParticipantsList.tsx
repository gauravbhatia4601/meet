/**
 * ParticipantsList Component
 * 
 * List of participants in the meeting
 */

import React from 'react';
import { X, Crown } from 'lucide-react';
import type { Participant } from '../../types/index.js';
import { ParticipantTile } from './ParticipantTile.js';

interface ParticipantsListProps {
  participants: Participant[];
  localParticipant: Participant | null;
  onClose?: () => void;
  className?: string;
}

export const ParticipantsList: React.FC<ParticipantsListProps> = ({
  participants,
  localParticipant,
  onClose,
  className = ''
}) => {
  const allParticipants = localParticipant
    ? [localParticipant, ...participants.filter(p => !p.isLocal)]
    : participants;

  return (
    <div className={`flex flex-col bg-gray-900 rounded-xl h-full overflow-hidden ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-700">
        <h3 className="text-white font-semibold">
          Participants ({allParticipants.length})
        </h3>
        {onClose && (
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Participants List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {allParticipants.map((participant) => (
          <div
            key={participant.peerId}
            className="flex items-center gap-3 p-3 bg-gray-800 rounded-xl"
          >
            {/* Avatar */}
            <div className="w-10 h-10 rounded-full bg-gray-700 flex items-center justify-center flex-shrink-0">
              <span className="text-sm font-semibold text-white">
                {participant.name.charAt(0).toUpperCase()}
              </span>
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-white font-medium truncate">
                  {participant.name}
                </span>
                {participant.isHost && (
                  <Crown className="w-4 h-4 text-yellow-400 flex-shrink-0" />
                )}
                {participant.isLocal && (
                  <span className="text-xs text-gray-400">(You)</span>
                )}
              </div>
              <div className="flex items-center gap-3 mt-1">
                <span
                  className={`text-xs ${
                    participant.videoEnabled ? 'text-green-400' : 'text-gray-400'
                  }`}
                >
                  {participant.videoEnabled ? 'Camera on' : 'Camera off'}
                </span>
                <span
                  className={`text-xs ${
                    participant.audioEnabled ? 'text-green-400' : 'text-gray-400'
                  }`}
                >
                  {participant.audioEnabled ? 'Mic on' : 'Mic off'}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

