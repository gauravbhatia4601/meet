/**
 * InfoPanel Component
 * 
 * Meeting information panel with call link
 */

import React, { useState } from 'react';
import { X, Copy, Check, Link2 } from 'lucide-react';

interface InfoPanelProps {
  roomCode: string;
  onClose?: () => void;
  className?: string;
}

export const InfoPanel: React.FC<InfoPanelProps> = ({
  roomCode,
  onClose,
  className = ''
}) => {
  const [copied, setCopied] = useState(false);

  const meetingUrl = `${window.location.origin}${window.location.pathname}?room=${roomCode}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(meetingUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleCopyCode = async () => {
    try {
      await navigator.clipboard.writeText(roomCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <div className={`flex flex-col bg-gray-900 rounded-xl h-full overflow-hidden ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-700">
        <h3 className="text-white font-semibold flex items-center gap-2">
          <Link2 className="w-5 h-5" />
          Meeting Information
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

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Meeting Code */}
        <div>
          <label className="text-gray-400 text-sm font-medium mb-2 block">
            Meeting Code
          </label>
          <div className="flex items-center gap-2">
            <div className="flex-1 bg-gray-800 rounded-lg px-4 py-3 text-white font-mono text-lg">
              {roomCode}
            </div>
            <button
              onClick={handleCopyCode}
              className="p-3 bg-gray-700 hover:bg-gray-600 rounded-lg text-white transition-colors"
            >
              {copied ? (
                <Check className="w-5 h-5 text-green-400" />
              ) : (
                <Copy className="w-5 h-5" />
              )}
            </button>
          </div>
        </div>

        {/* Meeting Link */}
        <div>
          <label className="text-gray-400 text-sm font-medium mb-2 block">
            Meeting Link
          </label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={meetingUrl}
              className="flex-1 bg-gray-800 rounded-lg px-4 py-3 text-white text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={handleCopy}
              className="p-3 bg-gray-700 hover:bg-gray-600 rounded-lg text-white transition-colors"
            >
              {copied ? (
                <Check className="w-5 h-5 text-green-400" />
              ) : (
                <Copy className="w-5 h-5" />
              )}
            </button>
          </div>
        </div>

        {/* Instructions */}
        <div className="pt-4 border-t border-gray-700">
          <p className="text-gray-400 text-sm">
            Share the meeting code or link with others to invite them to join the meeting.
          </p>
        </div>
      </div>
    </div>
  );
};

