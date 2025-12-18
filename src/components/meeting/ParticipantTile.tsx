/**
 * ParticipantTile Component
 * 
 * Displays a participant's video stream with controls and metadata
 */

import React, { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Video, VideoOff } from 'lucide-react';
import type { Participant } from '../../types/index.js';
import { Tooltip } from '../shared/Tooltip.js';

interface ParticipantTileProps {
  participant: Participant;
  isLocal?: boolean;
  isLarge?: boolean;
  className?: string;
}

export const ParticipantTile: React.FC<ParticipantTileProps> = ({
  participant,
  isLocal = false,
  isLarge = false,
  className = ''
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoError, setVideoError] = useState(false);

  // Attach stream to video element
  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) return;

    const stream = participant.stream;
    const hasVideo = participant.videoEnabled && stream?.getVideoTracks().some(t => t.readyState === 'live' && t.enabled);

    if (stream && hasVideo) {
      // Always set srcObject (force re-attachment) when video is enabled
      const currentSrcObject = videoElement.srcObject;
      if (currentSrcObject !== stream) {
        console.log(`[ParticipantTile] Setting srcObject for ${participant.name}`);
        videoElement.srcObject = stream;
      } else {
        // Even if same stream, ensure video is playing when enabled
        console.log(`[ParticipantTile] Stream already attached for ${participant.name}, checking playback`);
        if (videoElement.paused) {
          videoElement.play().catch(err => {
            if (err.name !== 'AbortError') {
              console.error('[ParticipantTile] Play failed (stream already attached):', err);
            }
          });
        }
      }
      
      // Force play with multiple retries
      const attemptPlay = async (retries = 5) => {
        try {
          const videoTrack = stream.getVideoTracks().find(t => t.readyState === 'live' && t.enabled);
          if (videoTrack && videoElement.srcObject === stream) {
            await videoElement.play();
            setVideoError(false);
            console.log(`[ParticipantTile] Video playing for ${participant.name}`);
          }
        } catch (error: any) {
          if (error.name !== 'AbortError' && retries > 0) {
            setTimeout(() => attemptPlay(retries - 1), 100);
          } else if (error.name !== 'AbortError') {
            console.error('[ParticipantTile] Failed to play video:', error);
            setVideoError(true);
          }
        }
      };

      // Multiple attempts with delays to ensure video element is ready
      [0, 50, 150, 300, 500, 800].forEach(delay => {
        setTimeout(() => {
          const videoTrack = stream.getVideoTracks().find(t => t.readyState === 'live' && t.enabled);
          if (videoElement.srcObject === stream && videoTrack) {
            attemptPlay();
          }
        }, delay);
      });
    } else {
      // Clear video if no stream or video disabled
      if (videoElement.srcObject) {
        videoElement.srcObject = null;
      }
      setVideoError(false);
    }

    // Handle video track state changes
    const handleTrackEnded = () => {
      setVideoError(true);
    };

    const handleTrackEnabledChange = () => {
      // Force re-check when track enabled state changes
      const videoTrack = stream?.getVideoTracks().find(t => t.readyState === 'live' && t.enabled);
      if (videoTrack) {
        console.log(`[ParticipantTile] Track enabled state changed for ${participant.name}, re-attaching video`);
        // Force re-attach by clearing and setting again
        const currentSrcObject = videoElement.srcObject;
        videoElement.srcObject = null;
        setTimeout(() => {
          videoElement.srcObject = stream;
          videoElement.play().catch(err => {
            if (err.name !== 'AbortError') {
              console.error('[ParticipantTile] Play failed after track enabled:', err);
            }
          });
        }, 10);
      } else {
        // Track disabled, clear video
        if (videoElement.srcObject) {
          videoElement.srcObject = null;
        }
      }
    };

    const videoTracks = stream?.getVideoTracks() || [];
    videoTracks.forEach(track => {
      track.addEventListener('ended', handleTrackEnded);
      track.addEventListener('enabled', handleTrackEnabledChange);
    });

    return () => {
      videoTracks.forEach(track => {
        track.removeEventListener('ended', handleTrackEnded);
        track.removeEventListener('enabled', handleTrackEnabledChange);
      });
    };
  }, [participant.stream, participant.videoEnabled]);

  // Handle video element ready
  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) return;

    const handleLoadedMetadata = () => {
      videoElement.play().catch((e) => {
        if (e.name !== 'AbortError') {
          console.error('[ParticipantTile] Play failed:', e);
        }
      });
    };

    const handleCanPlay = () => {
      videoElement.play().catch((e) => {
        if (e.name !== 'AbortError') {
          console.error('[ParticipantTile] Play failed:', e);
        }
      });
    };

    videoElement.addEventListener('loadedmetadata', handleLoadedMetadata);
    videoElement.addEventListener('canplay', handleCanPlay);

    return () => {
      videoElement.removeEventListener('loadedmetadata', handleLoadedMetadata);
      videoElement.removeEventListener('canplay', handleCanPlay);
    };
  }, []);

  // Check if video is actually available and enabled
  const videoTracks = participant.stream?.getVideoTracks() || [];
  const hasLiveEnabledVideo = videoTracks.some(t => t.readyState === 'live' && t.enabled);
  const hasVideo = participant.videoEnabled && hasLiveEnabledVideo;
  
  // Check if audio is actually available and enabled
  const audioTracks = participant.stream?.getAudioTracks() || [];
  const hasLiveEnabledAudio = audioTracks.some(t => t.readyState === 'live' && t.enabled);
  const hasAudio = participant.audioEnabled && hasLiveEnabledAudio;

  return (
    <div
      className={`relative bg-gray-900 rounded-xl overflow-hidden ${isLarge ? 'w-full h-full' : 'w-full h-full'} ${className}`}
    >
      {/* Video Element */}
      {hasVideo && !videoError ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isLocal} // Always mute local video to prevent feedback
          className="w-full h-full object-cover"
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-gray-800">
          <div className="text-center">
            <div className="w-20 h-20 rounded-full bg-gray-700 flex items-center justify-center mx-auto mb-3">
              <span className="text-2xl font-semibold text-white">
                {participant.name.charAt(0).toUpperCase()}
              </span>
            </div>
            <p className="text-white font-medium">{participant.name}</p>
          </div>
        </div>
      )}

      {/* Participant Info Bar */}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-white text-sm font-medium truncate">
              {participant.name}
              {isLocal && <span className="ml-1 text-gray-300">(You)</span>}
              {participant.isHost && <span className="ml-1">👑</span>}
            </span>
          </div>
          
          <div className="flex items-center gap-2">
            {/* Audio Status */}
            <Tooltip text={hasAudio ? 'Microphone on' : 'Microphone off'}>
              <div className={`p-1.5 rounded ${hasAudio ? 'bg-green-500/20' : 'bg-red-500/20'}`}>
                {hasAudio ? (
                  <Mic className="w-4 h-4 text-green-400" />
                ) : (
                  <MicOff className="w-4 h-4 text-red-400" />
                )}
              </div>
            </Tooltip>

            {/* Video Status */}
            <Tooltip text={hasVideo ? 'Camera on' : 'Camera off'}>
              <div className={`p-1.5 rounded ${hasVideo ? 'bg-green-500/20' : 'bg-red-500/20'}`}>
                {hasVideo ? (
                  <Video className="w-4 h-4 text-green-400" />
                ) : (
                  <VideoOff className="w-4 h-4 text-red-400" />
                )}
              </div>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* Speaking Indicator */}
      {participant.isSpeaking && (
        <div className="absolute inset-0 border-4 border-blue-500 rounded-lg pointer-events-none animate-pulse" />
      )}
    </div>
  );
};

