/**
 * Signaling Server Configuration
 */

const isDevelopment = import.meta.env.MODE === 'development';

// In production Docker, use the signaling server container name or the provided URL
export const SIGNALING_SERVER_URL = 
  import.meta.env.VITE_SIGNALING_SERVER_URL || 
  (isDevelopment ? 'http://localhost:3001' : 'http://server:3001');

export const SIGNALING_CONFIG = {
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 20000,
  transports: ['websocket', 'polling'] as const
};

