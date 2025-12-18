/**
 * LobbyView Component
 * 
 * Pre-meeting setup - Device selection and name entry
 */

import React, { useState, useEffect, useRef } from 'react';
import { Loader2, ArrowLeft } from 'lucide-react';
import { AppView } from '../../types/index.js';
import { useMedia, useMediaDevices } from '../../hooks/index.js';

interface LobbyViewProps {
  roomCode: string;
  isHost: boolean;
  onNavigate: (view: AppView) => void;
  onJoin: (userName: string) => Promise<void>;
}

export const LobbyView: React.FC<LobbyViewProps> = ({
  roomCode,
  isHost,
  onNavigate,
  onJoin
}) => {
  const [userName, setUserName] = useState('');
  const [isJoining, setIsJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Media hooks
  const media = useMedia({ autoStart: false }); // Don't auto-start, wait for devices
  const devices = useMediaDevices();

  // Refresh devices on mount and initialize stream once devices are ready
  useEffect(() => {
    const initDevicesAndStream = async () => {
      try {
        // First, refresh devices (this requests permissions)
        await devices.refreshDevices(true);
        
        // Wait for store to update with selected devices
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Always try to initialize stream (browser will use default devices if none selected)
        // The getMediaStream function handles empty device IDs by using defaults
        await media.initializeStream();
      } catch (error: any) {
        console.error('[LobbyView] Failed to initialize devices/stream:', error);
        setError(error.message || 'Failed to access camera/microphone. Please check permissions.');
      }
    };

    initDevicesAndStream();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount

  // Attach local stream to video element with retries
  useEffect(() => {
    if (!media.localStream || !videoRef.current) return;

    const videoElement = videoRef.current;
    
    // Force set srcObject
    videoElement.srcObject = media.localStream;
    
    // Try to play with multiple retries
    const attemptPlay = async (retries = 5) => {
      try {
        await videoElement.play();
      } catch (error: any) {
        if (error.name !== 'AbortError' && retries > 0) {
          setTimeout(() => attemptPlay(retries - 1), 100);
        } else if (error.name !== 'AbortError') {
          console.error('[LobbyView] Failed to play video:', error);
        }
      }
    };

    // Multiple attempts with delays
    [0, 50, 150, 300, 500].forEach(delay => {
      setTimeout(() => {
        if (videoElement.srcObject === media.localStream) {
          attemptPlay();
        }
      }, delay);
    });

    // Also on metadata load
    const handleLoadedMetadata = () => {
      videoElement.play().catch(e => {
        if (e.name !== 'AbortError') {
          console.error('[LobbyView] Play failed:', e);
        }
      });
    };

    const handleCanPlay = () => {
      videoElement.play().catch(e => {
        if (e.name !== 'AbortError') {
          console.error('[LobbyView] Play failed:', e);
        }
      });
    };

    videoElement.addEventListener('loadedmetadata', handleLoadedMetadata);
    videoElement.addEventListener('canplay', handleCanPlay);

    return () => {
      videoElement.removeEventListener('loadedmetadata', handleLoadedMetadata);
      videoElement.removeEventListener('canplay', handleCanPlay);
    };
  }, [media.localStream]);

  /**
   * Handle join meeting
   */
  const handleJoin = async () => {
    if (!userName.trim()) {
      setError('Please enter your name');
      return;
    }

    setIsJoining(true);
    setError(null);

    try {
      // Ensure stream is initialized
      if (!media.localStream) {
        await media.initializeStream();
        // Wait a bit for stream to be ready
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      await onJoin(userName.trim());
    } catch (err: any) {
      setError(err.message || 'Failed to join meeting');
      setIsJoining(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-black to-gray-900 flex items-center justify-center p-4">
      <div className="max-w-4xl w-full">
        <div className="bg-white/5 backdrop-blur-xl rounded-2xl border border-white/10 overflow-hidden">
          {/* Header */}
          <div className="p-6 border-b border-white/10">
            <button
              onClick={() => onNavigate(AppView.LANDING)}
              className="text-gray-400 hover:text-white transition-colors mb-4 flex items-center gap-2"
            >
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>
            <h2 className="text-2xl font-bold text-white mb-2">
              {isHost ? 'Start a meeting' : 'Join a meeting'}
            </h2>
            <p className="text-gray-400">
              Meeting code: <span className="font-mono font-semibold text-white">{roomCode}</span>
            </p>
          </div>

          <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Video Preview */}
            <div className="space-y-4">
              <h3 className="text-white font-semibold">Preview</h3>
              <div className="aspect-video bg-gray-800 rounded-lg overflow-hidden">
                {media.localStream ? (
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Loader2 className="w-8 h-8 text-gray-400 animate-spin" />
                  </div>
                )}
              </div>
            </div>

            {/* Settings */}
            <div className="space-y-4">
              {/* Name Input */}
              <div>
                <label className="text-sm text-gray-400 mb-2 block">
                  Your name
                </label>
                <input
                  type="text"
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  onKeyPress={(e) => {
                    if (e.key === 'Enter' && !isJoining) {
                      handleJoin();
                    }
                  }}
                  placeholder="Enter your name"
                  className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  autoFocus
                />
              </div>

              {/* Device Selection */}
              <div className="space-y-3">
                {/* Audio Input */}
                {devices.devices.audioInputs.length > 0 && (
                  <div>
                    <label className="text-sm text-gray-400 mb-2 block">
                      Microphone
                    </label>
                    <select
                      value={devices.selectedDevices.audioInput}
                      onChange={(e) => devices.selectAudioDevice(e.target.value)}
                      className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    >
                      {devices.devices.audioInputs.map((device) => (
                        <option
                          key={device.deviceId}
                          value={device.deviceId}
                          className="bg-gray-900"
                        >
                          {device.label || `Microphone ${device.deviceId.slice(0, 8)}`}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Video Input */}
                {devices.devices.videoInputs.length > 0 && (
                  <div>
                    <label className="text-sm text-gray-400 mb-2 block">
                      Camera
                    </label>
                    <select
                      value={devices.selectedDevices.videoInput}
                      onChange={(e) => devices.selectVideoDevice(e.target.value)}
                      className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    >
                      {devices.devices.videoInputs.map((device) => (
                        <option
                          key={device.deviceId}
                          value={device.deviceId}
                          className="bg-gray-900"
                        >
                          {device.label || `Camera ${device.deviceId.slice(0, 8)}`}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Audio Output */}
                {devices.devices.audioOutputs.length > 0 && (
                  <div>
                    <label className="text-sm text-gray-400 mb-2 block">
                      Speaker
                    </label>
                    <select
                      value={devices.selectedDevices.audioOutput}
                      onChange={(e) => devices.selectOutputDevice(e.target.value)}
                      className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    >
                      {devices.devices.audioOutputs.map((device) => (
                        <option
                          key={device.deviceId}
                          value={device.deviceId}
                          className="bg-gray-900"
                        >
                          {device.label || `Speaker ${device.deviceId.slice(0, 8)}`}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {/* Error Message */}
              {error && (
                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
                  {error}
                </div>
              )}

              {/* Join Button */}
              <button
                onClick={handleJoin}
                disabled={!userName.trim() || isJoining}
                className="w-full py-4 bg-white text-black font-semibold rounded-lg hover:bg-gray-100 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isJoining ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Joining...
                  </>
                ) : (
                  'Join Room'
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

