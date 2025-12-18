/**
 * Connection Store - Zustand store for connection state
 * 
 * Manages:
 * - Signaling connection state
 * - Connection errors
 * - Retry logic
 */

import { create } from 'zustand';
import { signalingClient, type ConnectionState } from '../services/signaling/index.js';

interface ConnectionStore {
  // State
  signalingState: ConnectionState;
  error: Error | null;
  retryCount: number;
  isConnected: boolean;

  // Actions
  setSignalingState: (state: ConnectionState) => void;
  setError: (error: Error | null) => void;
  incrementRetry: () => void;
  resetRetry: () => void;
  
  // Initialize: Subscribe to signaling client state
  initialize: () => () => void; // Returns cleanup function
}

export const useConnectionStore = create<ConnectionStore>((set, get) => {
  let unsubscribe: (() => void) | null = null;

  return {
    // Initial state
    signalingState: 'disconnected',
    error: null,
    retryCount: 0,
    isConnected: false,

    // Actions
    setSignalingState: (state) => {
      set({
        signalingState: state,
        isConnected: state === 'connected'
      });
    },

    setError: (error) => {
      set({ error });
    },

    incrementRetry: () => {
      set((state) => ({
        retryCount: state.retryCount + 1
      }));
    },

    resetRetry: () => {
      set({ retryCount: 0 });
    },

    // Initialize: Subscribe to signaling client
    initialize: () => {
      // Update state from current connection state
      const currentState = signalingClient.getConnectionState();
      set({
        signalingState: currentState,
        isConnected: currentState === 'connected'
      });

      // Set up callbacks to sync state
      signalingClient.setCallbacks({
        onConnected: () => {
          set({
            signalingState: 'connected',
            isConnected: true,
            error: null,
            retryCount: 0
          });
        },
        onDisconnected: () => {
          set({
            signalingState: 'disconnected',
            isConnected: false
          });
        },
        onError: (error) => {
          set({
            error,
            signalingState: 'error'
          });
        }
      });

      // Return cleanup function
      return () => {
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
      };
    }
  };
});

