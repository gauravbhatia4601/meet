/**
 * useMedia Hook
 * 
 * Combined hook for media management
 * Combines:
 * - Media stream management
 * - Device selection
 * - Media controls (mic/camera toggle)
 */

import { useCallback, useEffect } from 'react';
import { useMediaStore } from '../../store/mediaStore.js';
import { useMediaStream } from './useMediaStream.js';
import { useMediaDevices } from './useMediaDevices.js';
import { peerConnectionManager } from '../../services/webrtc/index.js';
import { signalingClient } from '../../services/signaling/index.js';

interface UseMediaOptions {
  autoStart?: boolean;
}

export const useMedia = (options: UseMediaOptions = {}) => {
  const { autoStart = false } = options;

  // Media store
  const localStream = useMediaStore(state => state.localStream);
  const isMicOn = useMediaStore(state => state.isMicOn);
  const isCamOn = useMediaStore(state => state.isCamOn);
  const isScreenSharing = useMediaStore(state => state.isScreenSharing);
  const selectedDevices = useMediaStore(state => state.selectedDevices);
  const toggleMic = useMediaStore(state => state.toggleMic);
  const toggleCam = useMediaStore(state => state.toggleCam);
  const toggleScreenShare = useMediaStore(state => state.toggleScreenShare);
  const setLocalStream = useMediaStore(state => state.setLocalStream);
  const initializeMedia = useMediaStore(state => state.initialize);

  // Media stream hook
  const {
    initializeStream,
    switchVideoDevice,
    switchAudioDevice,
    stopStream
  } = useMediaStream({
    autoStart,
    audioDeviceId: selectedDevices.audioInput,
    videoDeviceId: selectedDevices.videoInput
  });

  // Media devices hook
  const {
    devices,
    refreshDevices,
    selectAudioDevice,
    selectVideoDevice
  } = useMediaDevices();

  /**
   * Toggle microphone
   */
  const toggleMicrophone = useCallback(async () => {
    await toggleMic();
    // Broadcast state change
    signalingClient.sendMediaState(isCamOn, !isMicOn);
  }, [isMicOn, isCamOn, toggleMic]);

  /**
   * Toggle camera
   */
  const toggleCamera = useCallback(async () => {
    await toggleCam();
    // Broadcast state change
    signalingClient.sendMediaState(!isCamOn, isMicOn);
  }, [isMicOn, isCamOn, toggleCam]);

  /**
   * Switch audio device
   */
  const switchAudio = useCallback(async (deviceId: string) => {
    selectAudioDevice(deviceId);
    await switchAudioDevice(deviceId);
  }, [selectAudioDevice, switchAudioDevice]);

  /**
   * Switch video device
   */
  const switchVideo = useCallback(async (deviceId: string) => {
    selectVideoDevice(deviceId);
    await switchVideoDevice(deviceId);
  }, [selectVideoDevice, switchVideoDevice]);

  /**
   * Start screen share
   */
  const startScreenShare = useCallback(async () => {
    try {
      const { getDisplayMediaStream } = await import('../../../services/mediaUtils.js');
      const screenStream = await getDisplayMediaStream();
      
      // Replace video track with screen share
      const currentStream = localStream;
      if (currentStream) {
        const videoTrack = screenStream.getVideoTracks()[0];
        const audioTrack = currentStream.getAudioTracks()[0];
        
        const newStream = new MediaStream();
        if (audioTrack) newStream.addTrack(audioTrack);
        if (videoTrack) newStream.addTrack(videoTrack);
        
        setLocalStream(newStream);
        peerConnectionManager.setLocalStream(newStream);
        
        toggleScreenShare();
        signalingClient.notifyScreenShareStart();
        signalingClient.sendMediaState(isCamOn, isMicOn, true);
      }
    } catch (error) {
      console.error('[useMedia] Failed to start screen share:', error);
      throw error;
    }
  }, [localStream, isCamOn, isMicOn, setLocalStream, toggleScreenShare]);

  /**
   * Stop screen share
   */
  const stopScreenShare = useCallback(async () => {
    // Restore camera stream
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0];
      const videoTracks = localStream.getVideoTracks();
      
      // Check if we have a screen share track
      const isScreenTrack = videoTracks.some(track => 
        track.getSettings().displaySurface !== undefined
      );
      
      if (isScreenTrack) {
        // Reinitialize with camera
        await initializeStream();
      }
    }
    
    toggleScreenShare();
    signalingClient.notifyScreenShareStop();
    signalingClient.sendMediaState(isCamOn, isMicOn, false);
  }, [localStream, isCamOn, isMicOn, initializeStream, toggleScreenShare]);

  // Update peer connection manager when stream changes
  useEffect(() => {
    if (localStream) {
      peerConnectionManager.setLocalStream(localStream);
    }
  }, [localStream]);

  // Initialize media store
  useEffect(() => {
    const cleanup = initializeMedia();
    return cleanup;
  }, [initializeMedia]);

  return {
    // State
    localStream,
    isMicOn,
    isCamOn,
    isScreenSharing,
    devices,
    selectedDevices,

    // Actions
    initializeStream,
    toggleMicrophone,
    toggleCamera,
    switchAudio,
    switchVideo,
    refreshDevices,
    startScreenShare,
    stopScreenShare,
    stopStream
  };
};

