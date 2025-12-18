# Signaling Client Service

## Overview

The `SignalingClient` is the foundation for all WebRTC communication. It connects to the signaling server and handles all Socket.io events.

## Usage

```typescript
import { signalingClient } from './services/signaling';

// Connect to server
await signalingClient.connect();

// Set up event handlers
signalingClient.setCallbacks({
  onRoomJoined: (data) => {
    console.log('Joined room:', data);
  },
  onParticipantJoined: (data) => {
    console.log('New participant:', data);
  }
});

// Join a room
signalingClient.joinRoom('abc-xyz', 'my-peer-id', 'John Doe', true);

// Send messages
signalingClient.sendChatMessage('Hello!');
signalingClient.sendMediaState(true, true); // video on, audio on
```

## Testing

To test the signaling client:

1. Start the signaling server:
   ```bash
   cd server && npm run dev
   ```

2. In browser console (after starting frontend):
   ```javascript
   import { testSignalingClient } from './utils/testSignalingClient';
   const test = await testSignalingClient();
   ```

Or use the test function:
```typescript
import { testSignalingClient } from '../utils/testSignalingClient';

// In your component or test file
testSignalingClient().then(result => {
  console.log('Test result:', result);
  // result.signalingClient - the client instance
  // result.roomCode - test room code
  // result.peerId - test peer ID
  // result.disconnect() - disconnect function
});
```

## Status

✅ **Complete and ready to use**
- Connection management
- Event handling
- Room join/leave
- WebRTC signaling
- Media state
- Chat
- Screen share

