# Nebula Meet Signaling Server

WebSocket-based signaling server for Nebula Meet WebRTC application.

## Features

- ✅ **Room Management** - Create, join, and manage meeting rooms
- ✅ **WebRTC Signaling** - Relay offers, answers, and ICE candidates
- ✅ **Participant Tracking** - Track all participants in each room
- ✅ **Media Control** - Broadcast media state changes (mic/camera on/off)
- ✅ **Screen Sharing** - Handle screen share start/stop events
- ✅ **Chat** - Real-time chat messaging
- ✅ **Auto Cleanup** - Remove inactive rooms automatically
- ✅ **Host Management** - Automatic host reassignment if host leaves

## Architecture

```
server/
├── src/
│   ├── server.ts              # Main server entry point
│   ├── types/
│   │   └── index.ts           # TypeScript type definitions
│   ├── rooms/
│   │   └── RoomManager.ts     # Room state management
│   └── handlers/
│       ├── joinHandler.ts     # Join/leave room logic
│       ├── signalingHandler.ts # WebRTC signaling relay
│       ├── mediaHandler.ts    # Media control events
│       ├── chatHandler.ts     # Chat message handling
│       └── disconnectHandler.ts # Cleanup on disconnect
├── package.json
└── tsconfig.json
```

## Installation

```bash
cd server
npm install
```

## Configuration

Create a `.env` file (or copy from `.env.example`):

```env
PORT=3001
CORS_ORIGIN=http://localhost:5173
MAX_PARTICIPANTS_PER_ROOM=50
ROOM_TIMEOUT_MINUTES=60
LOG_LEVEL=debug
```

## Development

```bash
npm run dev
```

This starts the server with hot-reload using `tsx watch`.

## Production

```bash
npm run build
npm start
```

## API Endpoints

### Health Check
```
GET /health
```
Returns server status.

### Statistics
```
GET /stats
```
Returns room and participant statistics.

## Socket.IO Events

### Client → Server

#### `join-room`
Join or create a room.

```typescript
socket.emit('join-room', {
  roomCode: string;
  peerId: string;
  name: string;
  isHost?: boolean;
});
```

#### `leave-room`
Leave the current room.

#### `webrtc-offer`
Send WebRTC offer to peer.

```typescript
socket.emit('webrtc-offer', {
  to: string;        // Target peer ID
  offer: RTCSessionDescriptionInit;
});
```

#### `webrtc-answer`
Send WebRTC answer to peer.

```typescript
socket.emit('webrtc-answer', {
  to: string;
  answer: RTCSessionDescriptionInit;
});
```

#### `webrtc-ice-candidate`
Send ICE candidate to peer.

```typescript
socket.emit('webrtc-ice-candidate', {
  to: string;
  candidate: RTCIceCandidateInit;
});
```

#### `media-state`
Broadcast media state change.

```typescript
socket.emit('media-state', {
  videoEnabled: boolean;
  audioEnabled: boolean;
  screenSharing?: boolean;
});
```

#### `chat-message`
Send chat message.

```typescript
socket.emit('chat-message', {
  message: string;
});
```

### Server → Client

#### `room-joined`
Emitted when successfully joined a room.

```typescript
{
  roomCode: string;
  isHost: boolean;
  participants: ParticipantInfo[];
}
```

#### `room-error`
Emitted on error joining room.

```typescript
{
  code: string;
  message: string;
}
```

#### `participant-joined`
Emitted when new participant joins.

#### `participant-left`
Emitted when participant leaves.

#### `webrtc-offer`
Relayed WebRTC offer from another peer.

#### `webrtc-answer`
Relayed WebRTC answer from another peer.

#### `webrtc-ice-candidate`
Relayed ICE candidate from another peer.

## Testing

Test the server with a simple Socket.IO client:

```javascript
import { io } from 'socket.io-client';

const socket = io('http://localhost:3001');

socket.on('connect', () => {
  console.log('Connected to server');
  
  socket.emit('join-room', {
    roomCode: 'test-room',
    peerId: 'peer-123',
    name: 'Test User',
    isHost: true
  });
});

socket.on('room-joined', (data) => {
  console.log('Room joined:', data);
});
```

## Deployment

### Option 1: Self-hosted

1. Build the server:
   ```bash
   npm run build
   ```

2. Start with PM2 or similar:
   ```bash
   pm2 start dist/server.js --name nebula-meet-server
   ```

### Option 2: Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist ./dist
EXPOSE 3001
CMD ["node", "dist/server.js"]
```

### Option 3: Cloud Platform

- **Google Cloud Run** - Serverless container
- **AWS ECS/Fargate** - Container service
- **Heroku** - Platform as a service
- **Railway** - Modern deployment platform

## Monitoring

Monitor server health via:
- `/health` endpoint
- `/stats` endpoint for room statistics
- Socket.IO connection count
- Room cleanup logs

## License

MIT

