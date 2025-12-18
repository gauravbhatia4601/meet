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

// TODO: Replace with your self-hosted TURN server credentials
// Example for self-hosted coturn:
const SELF_HOSTED_TURN_SERVERS: ICEServer[] = [
  {
    urls: 'turn:your-turn-server.com:3478',
    username: process.env.REACT_APP_TURN_USERNAME || '',
    credential: process.env.REACT_APP_TURN_CREDENTIAL || ''
  }
];

/**
 * Get ICE servers configuration
 * 
 * @param useFreeTURN - Use free TURN servers (default: true for dev, false for prod)
 */
export const getICEServers = (useFreeTURN: boolean = true): RTCIceServer[] => {
  const stunServers = GOOGLE_STUN_SERVERS;
  const turnServers = useFreeTURN ? FREE_TURN_SERVERS : SELF_HOSTED_TURN_SERVERS;

  // Combine STUN and TURN servers
  return [...stunServers, ...turnServers] as RTCIceServer[];
};

/**
 * Default ICE configuration for RTCPeerConnection
 */
export const getRTCConfiguration = (): RTCConfiguration => {
  return {
    iceServers: getICEServers(),
    iceTransportPolicy: 'all', // Allow both direct and relay connections
    iceCandidatePoolSize: 10, // Pre-gather ICE candidates
  };
};


