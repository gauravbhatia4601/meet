/**
 * Media Store - Zustand store for media state
 * 
 * Prevents excessive re-renders by:
 * - Using Zustand's built-in optimizations
 * - Selective subscriptions (only subscribe to what you need)
 * - Immutable updates
 */

import { create } from 'zustand';
import { mediaStreamManager } from '../services/media/MediaStreamManager.js';

export interface DeviceConfig {
  audioInput: string;
  audioOutput: string;
  videoInput: string;
}

interface MediaStore {
  // State
  localStream: MediaStream | null;
  devices: {
    audioInputs: MediaDeviceInfo[];
    videoInputs: MediaDeviceInfo[];
    audioOutputs: MediaDeviceInfo[];
  };
  selectedDevices: DeviceConfig;
  isMicOn: boolean;
  isCamOn: boolean;
  isScreenSharing: boolean;

  // Actions
  setLocalStream: (stream: MediaStream | null) => void;
  setDevices: (devices: {
    audioInputs: MediaDeviceInfo[];
    videoInputs: MediaDeviceInfo[];
    audioOutputs: MediaDeviceInfo[];
  }) => void;
  selectDevice: (type: 'audio' | 'video' | 'output', deviceId: string) => void;
  toggleMic: () => Promise<void>;
  toggleCam: () => Promise<void>;
  toggleScreenShare: () => void;
  
  // Initialize: Subscribe to MediaStreamManager
  initialize: () => () => void; // Returns cleanup function
}

export const useMediaStore = create<MediaStore>((set, get) => {
  let unsubscribe: (() => void) | null = null;

  return {
    // Initial state
    localStream: null,
    devices: {
      audioInputs: [],
      videoInputs: [],
      audioOutputs: []
    },
    selectedDevices: {
      audioInput: '',
      audioOutput: '',
      videoInput: ''
    },
    isMicOn: true,
    isCamOn: true,
    isScreenSharing: false,

    // Actions
    setLocalStream: (stream) => {
      // Update MediaStreamManager
      mediaStreamManager.setStream(stream);
      // Update store (will be synced via subscribe)
      set({ localStream: stream });
    },

    setDevices: (devices) => {
      set({ devices });
    },

    selectDevice: (type, deviceId) => {
      const current = get().selectedDevices;
      const updates: Partial<DeviceConfig> = {};

      if (type === 'audio') {
        updates.audioInput = deviceId;
      } else if (type === 'video') {
        updates.videoInput = deviceId;
      } else if (type === 'output') {
        updates.audioOutput = deviceId;
      }

      set({
        selectedDevices: { ...current, ...updates }
      });
    },

    toggleMic: async () => {
      const current = get().isMicOn;
      const newState = !current;
      
      console.log(`[MediaStore] toggleMic: ${current} -> ${newState}`);
      
      // Try to update track state without recreating stream
      const success = mediaStreamManager.setTrackEnabled('audio', newState);
      
      console.log(`[MediaStore] setTrackEnabled returned: ${success}`);
      
      // Update state first
      set({ isMicOn: newState });
      
      // If tracks are stopped or missing, we need to recreate them
      if (!success && newState) {
        console.log('[MediaStore] Need to recreate audio track');
        // Recreate audio track
        const stream = get().localStream;
        const selectedDevices = get().selectedDevices;
        
        try {
          const { getAudioOnlyStream } = await import('../../services/mediaUtils.js');
          console.log('[MediaStore] Getting new audio stream with device:', selectedDevices.audioInput);
          const audioStream = await getAudioOnlyStream(
            selectedDevices.audioInput || undefined
          );
          const audioTrack = audioStream.getAudioTracks()[0];
          
          if (audioTrack) {
            console.log('[MediaStore] Got new audio track:', audioTrack.id);
            if (stream) {
              // Replace the stopped track with a new one (or add if none exists)
              const oldTrack = stream.getAudioTracks()[0];
              console.log('[MediaStore] Replacing audio track, old track:', oldTrack?.id || 'none');
              mediaStreamManager.replaceTrack('audio', audioTrack, oldTrack);
            } else {
              // No stream exists, create new one with just audio
              console.log('[MediaStore] Creating new stream with audio track');
              const newStream = new MediaStream([audioTrack]);
              mediaStreamManager.setStream(newStream);
              set({ localStream: newStream });
            }
            
            audioTrack.enabled = true;
            console.log('[MediaStore] Audio track enabled, readyState:', audioTrack.readyState);
            
            // Update peer connections with new track
            const { peerConnectionManager } = await import('../services/webrtc/index.js');
            const updatedStream = mediaStreamManager.getStream();
            if (updatedStream) {
              peerConnectionManager.setLocalStream(updatedStream);
              console.log('[MediaStore] Updated peer connections with new audio track');
            }
            
            // Stop the temporary stream (keep the track we extracted)
            audioStream.getTracks().forEach(t => {
              if (t.id !== audioTrack.id) t.stop();
            });
            
            console.log('[MediaStore] Successfully recreated audio track');
          } else {
            console.error('[MediaStore] No audio track in stream');
          }
        } catch (error) {
          console.error('[MediaStore] Failed to recreate audio track:', error);
          // Revert state on error
          set({ isMicOn: current });
        }
      } else if (success) {
        console.log('[MediaStore] Successfully toggled audio without recreation');
      }
    },

    toggleCam: async () => {
      const current = get().isCamOn;
      const newState = !current;
      
      console.log(`[MediaStore] toggleCam: ${current} -> ${newState}`);
      
      // Try to update track state without recreating stream
      const success = mediaStreamManager.setTrackEnabled('video', newState);
      
      console.log(`[MediaStore] setTrackEnabled returned: ${success}`);
      
      // Update state first
      set({ isCamOn: newState });
      
      // If tracks are stopped or missing, we need to recreate them
      if (!success && newState) {
        console.log('[MediaStore] Need to recreate video track');
        // Recreate video track
        const stream = get().localStream;
        const selectedDevices = get().selectedDevices;
        
        try {
          const { getVideoOnlyStream } = await import('../../services/mediaUtils.js');
          console.log('[MediaStore] Getting new video stream with device:', selectedDevices.videoInput);
          const videoStream = await getVideoOnlyStream(
            selectedDevices.videoInput || undefined,
            'high'
          );
          const videoTrack = videoStream.getVideoTracks()[0];
          
          if (videoTrack) {
            console.log('[MediaStore] Got new video track:', videoTrack.id);
            if (stream) {
              // Replace the stopped track with a new one (or add if none exists)
              const oldTrack = stream.getVideoTracks()[0];
              console.log('[MediaStore] Replacing video track, old track:', oldTrack?.id || 'none');
              mediaStreamManager.replaceTrack('video', videoTrack, oldTrack);
            } else {
              // No stream exists, create new one with just video
              console.log('[MediaStore] Creating new stream with video track');
              const newStream = new MediaStream([videoTrack]);
              mediaStreamManager.setStream(newStream);
              set({ localStream: newStream });
            }
            
            videoTrack.enabled = true;
            console.log('[MediaStore] Video track enabled, readyState:', videoTrack.readyState);
            
            // Update peer connections with new track
            const { peerConnectionManager } = await import('../services/webrtc/index.js');
            const updatedStream = mediaStreamManager.getStream();
            if (updatedStream) {
              peerConnectionManager.setLocalStream(updatedStream);
              console.log('[MediaStore] Updated peer connections with new video track');
            }
            
            // Stop the temporary stream (keep the track we extracted)
            videoStream.getTracks().forEach(t => {
              if (t.id !== videoTrack.id) t.stop();
            });
            
            console.log('[MediaStore] Successfully recreated video track');
          } else {
            console.error('[MediaStore] No video track in stream');
          }
        } catch (error) {
          console.error('[MediaStore] Failed to recreate video track:', error);
          // Revert state on error
          set({ isCamOn: current });
        }
      } else if (success) {
        console.log('[MediaStore] Successfully toggled video without recreation');
        // Update peer connections when track enabled state changes
        const stream = get().localStream;
        if (stream && newState) {
          const { peerConnectionManager } = await import('../services/webrtc/index.js');
          peerConnectionManager.setLocalStream(stream);
        }
      }
    },

    toggleScreenShare: () => {
      const current = get().isScreenSharing;
      set({ isScreenSharing: !current });
    },

    // Initialize: Subscribe to MediaStreamManager for sync
    initialize: () => {
      // Subscribe to stream changes from MediaStreamManager
      unsubscribe = mediaStreamManager.onStreamChange((stream) => {
        set({ localStream: stream });
      });

      // Return cleanup
      return () => {
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
      };
    }
  };
});


