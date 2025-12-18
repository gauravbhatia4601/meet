/**
 * Signaling Server Configuration
 */

const isDevelopment = import.meta.env.MODE === 'development';

/**
 * Get the signaling server URL, handling HTTPS/WSS conversion for production
 */
function getSignalingServerURL(): string {
  // Use explicit environment variable if provided
  let url = import.meta.env.VITE_SIGNALING_SERVER_URL;
  
  // Fallback to defaults if not provided
  if (!url) {
    url = isDevelopment ? 'http://localhost:3001' : 'http://localhost:3001';
  }
  
  // If the page is loaded over HTTPS, convert HTTP to HTTPS and WS to WSS
  if (typeof window !== 'undefined' && window.location.protocol === 'https:') {
    // Convert http:// to https://
    url = url.replace(/^http:\/\//, 'https://');
    // Ensure WebSocket will use WSS (Socket.io handles this automatically for https:// URLs)
  }
  
  return url;
}

export const SIGNALING_SERVER_URL = getSignalingServerURL();

export const SIGNALING_CONFIG = {
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 20000,
  transports: ['websocket', 'polling'] as const
};

