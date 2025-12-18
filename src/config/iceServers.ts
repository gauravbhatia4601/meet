/**
 * ICE Server Configuration
 * 
 * STUN: Free Google servers for discovering public IP addresses
 * TURN: Required for cross-network connections (NAT traversal)
 * 
 * Production: Use self-hosted coturn or Google Cloud
 * Development: Use free TURN servers (metered.ca) or self-hosted
 */

export interface ICEServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * Google STUN Servers (Free)
 * Used for discovering public IP addresses
 */
const GOOGLE_STUN_SERVERS: ICEServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' }
];

/**
 * TURN Server Configuration
 * 
 * Option 1: Self-hosted coturn (Recommended for Production)
 * Option 2: Free TURN servers (Development/Testing)
 * Option 3: Google Cloud coturn deployment
 */

// Free TURN servers for development (metered.ca)
const FREE_TURN_SERVERS: ICEServer[] = [
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  {
    urls: 'turn:openrelay.metered.ca:80?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
];

// Get environment variables (Vite uses import.meta.env)
const env = import.meta.env as {
  MODE?: string;
  VITE_TURN_SERVER_URL?: string;
  VITE_TURN_USERNAME?: string;
  VITE_TURN_CREDENTIAL?: string;
  VITE_USE_FREE_TURN?: string;
};

const isDevelopment = env.MODE === 'development';
const useFreeTURN = env.VITE_USE_FREE_TURN !== 'false'; // Default to true unless explicitly disabled

// Custom TURN server from environment variables
const getCustomTURNServers = (): ICEServer[] => {
  const turnUrl = env.VITE_TURN_SERVER_URL;
  const username = env.VITE_TURN_USERNAME;
  const credential = env.VITE_TURN_CREDENTIAL;

  if (!turnUrl) {
    return [];
  }

  // Support multiple URLs (comma-separated) or single URL
  const urls = turnUrl.split(',').map(url => url.trim()).filter(Boolean);
  
  return urls.map(url => {
    // Ensure URL has turn: or turns: protocol
    const protocolUrl = url.startsWith('turn:') || url.startsWith('turns:') 
      ? url 
      : `turn:${url}`;
    
    return {
      urls: protocolUrl,
      username: username || '',
      credential: credential || ''
    };
  });
};

// TODO: Replace with your self-hosted TURN server credentials
// Example for self-hosted coturn:
const SELF_HOSTED_TURN_SERVERS: ICEServer[] = [
  {
    urls: 'turn:your-turn-server.com:3478',
    username: '',
    credential: ''
  }
];

/**
 * Get ICE servers configuration
 * Priority:
 * 1. Custom TURN servers from environment variables (VITE_TURN_SERVER_URL)
 * 2. Free TURN servers (if useFreeTURN is true)
 * 3. Self-hosted TURN servers (if configured)
 * 
 * @param forceUseFreeTURN - Force use of free TURN servers (overrides env)
 */
export const getICEServers = (forceUseFreeTURN?: boolean): RTCIceServer[] => {
  const stunServers = GOOGLE_STUN_SERVERS;
  
  // Check for custom TURN servers from environment
  const customTURN = getCustomTURNServers();
  if (customTURN.length > 0) {
    console.log('[ICE] Using custom TURN servers from environment:', customTURN.map(s => s.urls));
    return [...stunServers, ...customTURN] as RTCIceServer[];
  }

  // Determine which TURN servers to use
  const shouldUseFree = forceUseFreeTURN !== undefined ? forceUseFreeTURN : useFreeTURN;
  const turnServers = shouldUseFree ? FREE_TURN_SERVERS : SELF_HOSTED_TURN_SERVERS;

  if (shouldUseFree) {
    console.log('[ICE] Using free TURN servers (metered.ca)');
  } else {
    console.warn('[ICE] Using self-hosted TURN servers (may not be configured)');
  }

  // Combine STUN and TURN servers
  const allServers = [...stunServers, ...turnServers] as RTCIceServer[];
  console.log(`[ICE] Total ICE servers: ${allServers.length} (${stunServers.length} STUN, ${turnServers.length} TURN)`);
  
  return allServers;
};

/**
 * Default ICE configuration for RTCPeerConnection
 */
export const getRTCConfiguration = (): RTCConfiguration => {
  const iceServers = getICEServers();
  
  return {
    iceServers,
    iceTransportPolicy: 'all', // Allow both direct and relay connections
    iceCandidatePoolSize: 10, // Pre-gather ICE candidates
  };
};


