/**
 * useMediaDevices Hook
 * 
 * Manages media device enumeration and selection
 */

import { useEffect, useCallback } from 'react';
import { useMediaStore } from '../../store/mediaStore.js';
import { getConnectedDevices } from '../../../services/mediaUtils.js';

export const useMediaDevices = () => {
  const devices = useMediaStore(state => state.devices);
  const selectedDevices = useMediaStore(state => state.selectedDevices);
  const setDevices = useMediaStore(state => state.setDevices);
  const selectDevice = useMediaStore(state => state.selectDevice);

  /**
   * Refresh device list
   */
  const refreshDevices = useCallback(async (requestPermissions: boolean = false) => {
    try {
      const deviceList = await getConnectedDevices(requestPermissions);
      setDevices(deviceList);

      // Get current selected devices from store (not from hook dependency to avoid circular dependency)
      const currentSelected = useMediaStore.getState().selectedDevices;

      // Auto-select first devices if none selected
      if (!currentSelected.audioInput && deviceList.audioInputs.length > 0) {
        selectDevice('audio', deviceList.audioInputs[0].deviceId);
      }
      if (!currentSelected.videoInput && deviceList.videoInputs.length > 0) {
        selectDevice('video', deviceList.videoInputs[0].deviceId);
      }
      if (!currentSelected.audioOutput && deviceList.audioOutputs.length > 0) {
        selectDevice('output', deviceList.audioOutputs[0].deviceId);
      }
    } catch (error) {
      console.error('[useMediaDevices] Failed to refresh devices:', error);
      throw error;
    }
  }, [setDevices, selectDevice]); // Removed selectedDevices from dependency

  /**
   * Select a device
   */
  const selectAudioDevice = useCallback((deviceId: string) => {
    selectDevice('audio', deviceId);
  }, [selectDevice]);

  const selectVideoDevice = useCallback((deviceId: string) => {
    selectDevice('video', deviceId);
  }, [selectDevice]);

  const selectOutputDevice = useCallback((deviceId: string) => {
    selectDevice('output', deviceId);
  }, [selectDevice]);

  return {
    devices,
    selectedDevices,
    refreshDevices,
    selectAudioDevice,
    selectVideoDevice,
    selectOutputDevice
  };
};

