/**
 * useMediaStream Hook
 * 
 * Manages media stream lifecycle with proper cleanup
 * Prevents device hanging by:
 * - Using refs instead of state for stream
 * - Only recreating stream when device actually changes
 * - Proper cleanup on unmount
 */

import { useEffect, useRef, useCallback } from 'react';
import { useMediaStore } from '../../store/mediaStore.js';
import { mediaStreamManager } from '../../services/media/MediaStreamManager.js';
import { getMediaStream, getVideoOnlyStream, getAudioOnlyStream } from '../../services/media/mediaUtils.js';

interface UseMediaStreamOptions {
  autoStart?: boolean;
  audioDeviceId?: string;
  videoDeviceId?: string;
  quality?: 'high' | 'low';
}

export const useMediaStream = (options: UseMediaStreamOptions = {}) => {
  const { autoStart = true, audioDeviceId, videoDeviceId, quality = 'high' } = options;
  
  const store = useMediaStore();
  const isInitializing = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  /**
   * Initialize media stream
   * Only creates stream if it doesn't exist or device changed
   */
  const initializeStream = useCallback(async () => {
    // Check if stream already exists and is valid
    const existingStream = mediaStreamManager.getStream();
    if (existingStream) {
      const audioTrack = existingStream.getAudioTracks()[0];
      const videoTrack = existingStream.getVideoTracks()[0];
      const hasValidTracks = 
        (!audioTrack || audioTrack.readyState === 'live') &&
        (!videoTrack || videoTrack.readyState === 'live');
      
      if (hasValidTracks) {
        // Check if devices match
        const currentAudioId = audioTrack?.getSettings().deviceId;
        const currentVideoId = videoTrack?.getSettings().deviceId;
        const audioMatches = !audioDeviceId || !currentAudioId || currentAudioId === audioDeviceId;
        const videoMatches = !videoDeviceId || !currentVideoId || currentVideoId === videoDeviceId;
        
        if (audioMatches && videoMatches) {
          console.log('[useMediaStream] Stream already exists with correct devices, reusing');
          return; // Stream is valid, no need to recreate
        }
      }
    }

    // Prevent concurrent initialization
    if (isInitializing.current) {
      console.warn('[useMediaStream] Already initializing, waiting for completion...');
      // Wait for current initialization to complete (max 5 seconds)
      let waitCount = 0;
      while (isInitializing.current && waitCount < 50) {
        await new Promise(resolve => setTimeout(resolve, 100));
        waitCount++;
      }
      // Check if stream was created during wait
      const streamAfterWait = mediaStreamManager.getStream();
      if (streamAfterWait) {
        console.log('[useMediaStream] Stream became available during wait');
        return;
      }
      // If still initializing after max wait, proceed anyway (might be stuck)
      if (isInitializing.current) {
        console.warn('[useMediaStream] Initialization taking too long, proceeding anyway...');
        isInitializing.current = false; // Reset flag to allow retry
      }
    }

    // Abort any pending requests
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    isInitializing.current = true;
    abortControllerRef.current = new AbortController();

    try {
      // Stream existence check was moved above to prevent blocking

      // Create new stream with selected devices
      // Allow undefined device IDs (browser will use default device)
      const stream = await getMediaStream(
        audioDeviceId && audioDeviceId.trim() !== '' ? audioDeviceId : undefined,
        videoDeviceId && videoDeviceId.trim() !== '' ? videoDeviceId : undefined,
        quality
      );

      // Validate we got a stream
      if (!stream) {
        throw new Error('Failed to get media stream');
      }

      // Validate we have at least one track
      if (stream.getTracks().length === 0) {
        throw new Error('Media stream has no tracks');
      }

      // Check if aborted
      if (abortControllerRef.current.signal.aborted) {
        // Clean up stream if request was aborted
        stream.getTracks().forEach(track => track.stop());
        return;
      }

      // Set stream in manager (will notify store)
      mediaStreamManager.setStream(stream);
      store.setLocalStream(stream);

      // Enable/disable tracks based on store state
      mediaStreamManager.setTrackEnabled('audio', store.isMicOn);
      mediaStreamManager.setTrackEnabled('video', store.isCamOn);

    } catch (error: any) {
      console.error('[useMediaStream] Failed to initialize stream:', error);
      
      if (!abortControllerRef.current.signal.aborted) {
        // Only show error if not aborted
        throw error;
      }
    } finally {
      isInitializing.current = false;
    }
  }, [audioDeviceId, videoDeviceId, quality, store]);

  /**
   * Switch video device without recreating entire stream
   */
  const switchVideoDevice = useCallback(async (newDeviceId: string) => {
    if (isInitializing.current) return;

    isInitializing.current = true;

    try {
      const currentStream = mediaStreamManager.getStream();
      if (!currentStream) {
        // No stream exists, create new one
        await initializeStream();
        return;
      }

      // Get old video track
      const oldVideoTrack = currentStream.getVideoTracks()[0];

      // Create new video stream with new device
      const newVideoStream = await getVideoOnlyStream(newDeviceId, quality);
      const newVideoTrack = newVideoStream.getVideoTracks()[0];

      // Replace track in manager (doesn't recreate stream)
      mediaStreamManager.replaceTrack('video', newVideoTrack, oldVideoTrack);

      // Update selected device
      store.selectDevice('video', newDeviceId);

      // Enable/disable based on current state
      newVideoTrack.enabled = store.isCamOn;

      // Stop unused video stream
      newVideoStream.getVideoTracks().forEach(track => {
        if (track.id !== newVideoTrack.id) track.stop();
      });
      newVideoStream.getAudioTracks().forEach(track => track.stop());

    } catch (error) {
      console.error('[useMediaStream] Failed to switch video device:', error);
      throw error;
    } finally {
      isInitializing.current = false;
    }
  }, [quality, store, initializeStream]);

  /**
   * Switch audio device without recreating entire stream
   */
  const switchAudioDevice = useCallback(async (newDeviceId: string) => {
    if (isInitializing.current) return;

    isInitializing.current = true;

    try {
      const currentStream = mediaStreamManager.getStream();
      if (!currentStream) {
        // No stream exists, create new one
        await initializeStream();
        return;
      }

      // Get old audio track
      const oldAudioTrack = currentStream.getAudioTracks()[0];

      // Create new audio stream with new device
      const newAudioStream = await getAudioOnlyStream(newDeviceId);
      const newAudioTrack = newAudioStream.getAudioTracks()[0];

      // Replace track in manager (doesn't recreate stream)
      mediaStreamManager.replaceTrack('audio', newAudioTrack, oldAudioTrack);

      // Update selected device
      store.selectDevice('audio', newDeviceId);

      // Enable/disable based on current state
      newAudioTrack.enabled = store.isMicOn;

      // Stop unused audio stream
      newAudioStream.getVideoTracks().forEach(track => track.stop());
      newAudioStream.getAudioTracks().forEach(track => {
        if (track.id !== newAudioTrack.id) track.stop();
      });

    } catch (error) {
      console.error('[useMediaStream] Failed to switch audio device:', error);
      throw error;
    } finally {
      isInitializing.current = false;
    }
  }, [store, initializeStream]);

  /**
   * Stop stream
   */
  const stopStream = useCallback(() => {
    mediaStreamManager.stopStream();
  }, []);

  // Initialize on mount if autoStart AND devices are available
  useEffect(() => {
    if (autoStart) {
      // Only initialize if we have at least one device selected
      if (audioDeviceId || videoDeviceId) {
        initializeStream();
      }
    }

    // Cleanup on unmount
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [autoStart]); // Only run on mount/unmount

  // Re-initialize when devices change (but only if stream doesn't already have them)
  useEffect(() => {
    if (!autoStart) return; // Only auto-initialize if autoStart is enabled
    
    // Wait a bit for devices to be selected (they might be empty initially)
    // We'll let manual initialization handle the initial stream creation
    if (!audioDeviceId && !videoDeviceId) {
      // Try to initialize anyway with default devices after a delay
      const timeoutId = setTimeout(() => {
        const currentStream = mediaStreamManager.getStream();
        if (!currentStream) {
          initializeStream(); // Try with default devices
        }
      }, 500);
      return () => clearTimeout(timeoutId);
    }
    
    const currentStream = mediaStreamManager.getStream();
    if (currentStream) {
      const audioTrack = currentStream.getAudioTracks()[0];
      const videoTrack = currentStream.getVideoTracks()[0];
      const currentAudioId = audioTrack?.getSettings().deviceId;
      const currentVideoId = videoTrack?.getSettings().deviceId;

      // Only reinitialize if devices actually changed
      if (currentAudioId !== audioDeviceId || currentVideoId !== videoDeviceId) {
        initializeStream();
      }
    } else {
      // No stream exists yet, initialize it
      initializeStream();
    }
  }, [audioDeviceId, videoDeviceId, autoStart, initializeStream]);

  return {
    stream: store.localStream,
    initializeStream,
    switchVideoDevice,
    switchAudioDevice,
    stopStream,
    isInitializing: isInitializing.current
  };
};


