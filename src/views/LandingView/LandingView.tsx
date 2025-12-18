/**
 * LandingView Component
 * 
 * Home page - Create or join a meeting
 */

import React, { useState } from 'react';
import { Plus, Keyboard, Copy, Check, ArrowRight } from 'lucide-react';
import { AppView } from '../../types/index.js';

interface LandingViewProps {
  onNavigate: (view: AppView, data?: { roomCode?: string; isHost?: boolean }) => void;
}

export const LandingView: React.FC<LandingViewProps> = ({ onNavigate }) => {
  const [meetingCode, setMeetingCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [showCreateOptions, setShowCreateOptions] = useState(false);
  const [createdLink, setCreatedLink] = useState<string | null>(null);

  /**
   * Generate a meeting code
   */
  const generateMeetingCode = (): string => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const parts = [];
    for (let i = 0; i < 3; i++) {
      parts.push(
        Array.from({ length: 3 }, () => 
          chars[Math.floor(Math.random() * chars.length)]
        ).join('')
      );
    }
    return parts.join('-');
  };

  /**
   * Create a new meeting
   */
  const handleCreateMeeting = () => {
    const code = generateMeetingCode();
    setCreatedLink(code);
    setShowCreateOptions(true);
  };

  /**
   * Start the created meeting
   */
  const handleStartMeeting = () => {
    if (createdLink) {
      onNavigate(AppView.LOBBY, { roomCode: createdLink, isHost: true });
    }
  };

  /**
   * Copy meeting link
   */
  const handleCopyLink = () => {
    if (createdLink) {
      const fullLink = `${window.location.origin}?code=${createdLink}`;
      navigator.clipboard.writeText(fullLink).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  };

  /**
   * Join a meeting
   */
  const handleJoinMeeting = () => {
    const cleanCode = meetingCode.trim().toLowerCase().replace(/\s+/g, '-');
    if (cleanCode) {
      onNavigate(AppView.LOBBY, { roomCode: cleanCode, isHost: false });
    }
  };

  /**
   * Handle keyboard shortcut (Cmd/Ctrl + K)
   */
  React.useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        document.getElementById('meeting-code-input')?.focus();
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-black to-gray-900 flex items-center justify-center p-4">
      <div className="max-w-2xl w-full space-y-8">
        {/* Header */}
        <div className="text-center space-y-4">
          <h1 className="text-5xl md:text-6xl font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
            Nebula Meet
          </h1>
          <p className="text-gray-400 text-lg">
            Premium video meetings. Now free for everyone.
          </p>
        </div>

        {/* Create Meeting Section */}
        <div className="bg-white/5 backdrop-blur-xl rounded-2xl p-8 border border-white/10 space-y-6">
          {!showCreateOptions ? (
            <>
              <button
                onClick={handleCreateMeeting}
                className="w-full py-4 bg-white text-black font-semibold rounded-xl hover:bg-gray-100 transition-all flex items-center justify-center gap-2 group"
              >
                <Plus className="w-5 h-5 group-hover:scale-110 transition-transform" />
                New Meeting
              </button>

              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-white/10"></div>
                </div>
                <div className="relative flex justify-center text-sm">
                  <span className="px-4 bg-black text-gray-400">or join with a code</span>
                </div>
              </div>

              <div className="flex gap-3">
                <div className="flex-1 relative">
                  <Keyboard className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                  <input
                    id="meeting-code-input"
                    type="text"
                    value={meetingCode}
                    onChange={(e) => setMeetingCode(e.target.value)}
                    onKeyPress={(e) => {
                      if (e.key === 'Enter') {
                        handleJoinMeeting();
                      }
                    }}
                    placeholder="Enter a code or link"
                    className="w-full pl-10 pr-4 py-3 bg-white/5 border border-white/10 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
                <button
                  onClick={handleJoinMeeting}
                  disabled={!meetingCode.trim()}
                  className="px-6 py-3 bg-blue-500 hover:bg-blue-600 text-white font-medium rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
                >
                  Join
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>

              <p className="text-xs text-gray-400 text-center">
                Press <kbd className="px-2 py-1 bg-white/10 rounded text-xs">⌘</kbd> <kbd className="px-2 py-1 bg-white/10 rounded text-xs">K</kbd> to quickly join a meeting
              </p>
            </>
          ) : (
            <>
              <div className="space-y-4">
                <div>
                  <label className="text-sm text-gray-400 mb-2 block">
                    Your meeting code
                  </label>
                  <div className="flex gap-2">
                    <div className="flex-1 px-4 py-3 bg-white/5 border border-white/10 rounded-lg text-white font-mono text-lg">
                      {createdLink}
                    </div>
                    <button
                      onClick={handleCopyLink}
                      className="px-4 py-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-white transition-colors"
                    >
                      {copied ? (
                        <Check className="w-5 h-5 text-green-400" />
                      ) : (
                        <Copy className="w-5 h-5" />
                      )}
                    </button>
                  </div>
                </div>

                <div className="flex gap-3">
                  <button
                    onClick={handleStartMeeting}
                    className="flex-1 py-4 bg-white text-black font-semibold rounded-xl hover:bg-gray-100 transition-all flex items-center justify-center gap-2"
                  >
                    Start Meeting
                    <ArrowRight className="w-5 h-5" />
                  </button>
                  <button
                    onClick={() => {
                      setShowCreateOptions(false);
                      setCreatedLink(null);
                    }}
                    className="px-6 py-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-white transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Features */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-center">
          <div className="p-4 bg-white/5 backdrop-blur-xl rounded-xl border border-white/10">
            <h3 className="text-white font-semibold mb-2">Secure</h3>
            <p className="text-gray-400 text-sm">
              End-to-end encrypted meetings
            </p>
          </div>
          <div className="p-4 bg-white/5 backdrop-blur-xl rounded-xl border border-white/10">
            <h3 className="text-white font-semibold mb-2">Fast</h3>
            <p className="text-gray-400 text-sm">
              Low latency, high quality
            </p>
          </div>
          <div className="p-4 bg-white/5 backdrop-blur-xl rounded-xl border border-white/10">
            <h3 className="text-white font-semibold mb-2">Free</h3>
            <p className="text-gray-400 text-sm">
              No account required
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

