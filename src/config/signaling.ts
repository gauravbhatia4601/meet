/**
 * Signaling Server Configuration
 */

// Type assertion for Vite environment variables
const env = import.meta.env as {
  MODE?: string;
  VITE_SIGNALING_SERVER_URL?: string;
};

const isDevelopment = env.MODE === 'development';

/**
 * Get the signaling server URL, handling HTTPS/WSS conversion for production
 */
function getSignalingServerURL(): string {
  // Use explicit environment variable if provided
  let url = env.VITE_SIGNALING_SERVER_URL;
  
  // Fallback to defaults if not provided
  if (!url) {
    url = isDevelopment ? 'http://localhost:3001' : 'https://meet.technioz.com';
  }
  
  // Remove trailing slash if present (Socket.io handles paths)
  url = url.replace(/\/$/, '');
  
  // If the page is loaded over HTTPS, convert HTTP to HTTPS and WS to WSS
  if (typeof window !== 'undefined' && window.location.protocol === 'https:') {
    // Convert http:// to https://
    url = url.replace(/^http:\/\//, 'https://');
    
    // If URL still has a port, try removing it (assuming reverse proxy)
    // This allows using the same domain without specifying port
    // e.g., https://meet.technioz.com:3001 -> https://meet.technioz.com
    // The reverse proxy should route /socket.io/ to the backend
    if (url.includes(':3001')) {
      console.warn('[Signaling] Port 3001 detected with HTTPS. If using reverse proxy, remove port from URL.');
      console.warn('[Signaling] Current URL:', url);
      // Optionally auto-remove port if using same domain
      const urlObj = new URL(url);
      if (urlObj.port === '3001' && urlObj.hostname === window.location.hostname) {
        console.log('[Signaling] Same domain detected, removing port (assuming reverse proxy)');
        url = `${urlObj.protocol}//${urlObj.hostname}`;
      }
    }
    
    // Ensure WebSocket will use WSS (Socket.io handles this automatically for https:// URLs)
  }
  
  console.log('[Signaling] Final signaling server URL:', url);
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

