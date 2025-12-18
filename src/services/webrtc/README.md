# WebRTC Peer Connection Manager

## Overview

The `PeerConnectionManager` manages all WebRTC peer-to-peer connections. It handles:
- Creating and destroying peer connections
- WebRTC offer/answer exchange (via SignalingClient)
- ICE candidate handling
- Media stream attachment
- Data channels for chat
- Connection state tracking

## Usage

```typescript
import { peerConnectionManager } from './services/webrtc';

// Initialize with your peer ID
peerConnectionManager.initialize('my-peer-id');

// Set local stream
peerConnectionManager.setLocalStream(localMediaStream);

// Set callbacks
peerConnectionManager.setCallbacks({
  onStreamAdded: (peerId, stream) => {
    console.log('Received stream from:', peerId);
    // Attach stream to video element
  },
  onStreamRemoved: (peerId) => {
    console.log('Stream removed from:', peerId);
  },
  onConnectionStateChanged: (peerId, state) => {
    console.log(`${peerId} connection state:`, state);
  }
});

// Add a peer (initiator creates offer)
await peerConnectionManager.addPeer('remote-peer-id', true);

// Add a peer (non-initiator waits for offer)
await peerConnectionManager.addPeer('remote-peer-id', false);

// Send message via data channel
peerConnectionManager.sendMessage('peer-id', 'Hello!');

// Broadcast to all
peerConnectionManager.broadcastMessage('Hello everyone!');

// Remove peer
peerConnectionManager.removePeer('peer-id');
```

## How It Works

1. **Initialization**: Call `initialize()` with your local peer ID
2. **Local Stream**: Set your local media stream with `setLocalStream()`
3. **Adding Peers**: When a participant joins, call `addPeer()` with their peer ID
4. **Signaling**: The manager automatically handles offer/answer via SignalingClient
5. **Streams**: When a remote stream is received, `onStreamAdded` callback is fired
6. **Cleanup**: Call `removePeer()` or `destroy()` to cleanup

## Integration with SignalingClient

The PeerConnectionManager uses SignalingClient for:
- Receiving offers/answers
- Sending offers/answers
- Exchanging ICE candidates

This is set up automatically when you call `initialize()`.

## Mesh Network

The manager supports a full mesh network where each peer connects to all other peers. This is set up automatically as participants join the room.

## Status

✅ **Complete and ready to use**
- Peer connection management
- Offer/answer exchange
- ICE candidate handling
- Media stream handling
- Data channels
- Connection state tracking

