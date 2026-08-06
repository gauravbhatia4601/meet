import 'dotenv/config';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { Server, type Socket } from 'socket.io';
import { roomManager, type Room } from './roomManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT ?? 3001);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';
const NODE_ENV = process.env.NODE_ENV ?? 'development';

// --- WebRTC ICE configuration ---
// STUN is always provided. For reliable connectivity on the public internet
// behind strict NATs/firewalls, configure a TURN server. Two options:
//
// 1) Cloudflare TURN (recommended): set CLOUDFLARE_TURN_TOKEN_ID and
//    CLOUDFLARE_TURN_API_TOKEN. The server calls Cloudflare's API to mint
//    short-lived credentials on the fly for each /api/rtc-config request, so
//    credentials never ship in the client bundle and rotate automatically.
//
// 2) Static TURN: set TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL.
//
// The client fetches this config from /api/rtc-config before creating peer
// connections.
const CLOUDFLARE_TURN_TOKEN_ID = process.env.CLOUDFLARE_TURN_TOKEN_ID ?? '';
const CLOUDFLARE_TURN_API_TOKEN = process.env.CLOUDFLARE_TURN_API_TOKEN ?? '';
const CLOUDFLARE_TURN_TTL = Number(process.env.CLOUDFLARE_TURN_TTL ?? 86400);
const TURN_URLS = (process.env.TURN_URLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const TURN_USERNAME = process.env.TURN_USERNAME ?? '';
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL ?? '';

const CLOUDFLARE_TURN_ENABLED = Boolean(CLOUDFLARE_TURN_TOKEN_ID && CLOUDFLARE_TURN_API_TOKEN);

/**
 * Mint short-lived Cloudflare TURN/STUN ICE servers via the Cloudflare API.
 * Returns null when Cloudflare TURN is not configured or the call fails.
 */
async function buildCloudflareIceServers(): Promise<RTCIceServer[] | null> {
  if (!CLOUDFLARE_TURN_ENABLED) return null;
  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${CLOUDFLARE_TURN_TOKEN_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CLOUDFLARE_TURN_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: CLOUDFLARE_TURN_TTL }),
      },
    );
    if (!res.ok) {
      console.error(`[rtc] Cloudflare TURN credential request failed: ${res.status} ${res.statusText}`);
      return null;
    }
    const data = (await res.json()) as { iceServers: RTCIceServer[] };
    return data.iceServers ?? null;
  } catch (err) {
    console.error('[rtc] Cloudflare TURN credential request threw', err);
    return null;
  }
}

function buildStaticIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  if (TURN_URLS.length > 0 && TURN_USERNAME && TURN_CREDENTIAL) {
    servers.push({ urls: TURN_URLS, username: TURN_USERNAME, credential: TURN_CREDENTIAL });
  }
  return servers;
}

async function buildIceServers(): Promise<RTCIceServer[]> {
  const cloudflare = await buildCloudflareIceServers();
  if (cloudflare) return cloudflare;
  return buildStaticIceServers();
}

// Optional TLS. When TLS_CERT and TLS_KEY are set, the server serves HTTPS so
// camera/microphone (secure-context APIs) work over the intranet. Generate a
// self-signed cert with:
//   openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem \
//     -days 365 -subj "/CN=localhost"
const TLS_CERT = process.env.TLS_CERT ?? '';
const TLS_KEY = process.env.TLS_KEY ?? '';

let tlsCredentials: { cert: Buffer; key: Buffer } | undefined;
if (TLS_CERT && TLS_KEY) {
  tlsCredentials = {
    cert: fs.readFileSync(TLS_CERT),
    key: fs.readFileSync(TLS_KEY),
  };
}

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: CLIENT_ORIGIN, credentials: true }));
app.use(express.json());

const server = tlsCredentials
  ? https.createServer(tlsCredentials, app)
  : http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

/** Health check for load balancers / k8s probes. */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: Date.now() });
});

/** Serve the WebRTC ICE configuration (STUN + optional TURN) to clients. */
app.get('/api/rtc-config', async (_req, res) => {
  res.json({ iceServers: await buildIceServers() });
});

/** Create a new room and return its code. */
app.post('/api/rooms', (_req, res) => {
  const roomId = roomManager.createRoom();
  res.status(201).json({ roomId });
});

/** Validate whether a room exists before joining. */
app.get('/api/rooms/:roomId', (req, res) => {
  const room = roomManager.getRoom(req.params.roomId);
  if (!room) {
    res.status(404).json({ error: 'Room not found' });
    return;
  }
  res.json({ roomId: room.id, participantCount: room.participants.size });
});

// Serve the built client in production so a single process serves everything.
if (NODE_ENV === 'production') {
  const clientDist = path.join(__dirname, '../../client/dist');
  app.use(express.static(clientDist));
  app.get(/^(?!\/api|\/health|\/socket\.io).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

/** Emit the full roster to every participant in the room. */
function broadcastRoster(room: Room) {
  io.to(room.id).emit('participants', {
    participants: roomManager.listParticipants(room).map((p) => ({
      id: p.id,
      socketId: p.socketId,
      displayName: p.displayName,
    })),
    hostId: room.hostId,
  });
}

/** Notify existing peers that a new user wants to connect (offer). */
function broadcastNewPeer(room: Room, socketId: string) {
  for (const peer of room.participants.values()) {
    if (peer.socketId !== socketId) {
      io.to(peer.socketId).emit('new-peer', { peerSocketId: socketId });
    }
  }
}

io.on('connection', (socket: Socket) => {
  socket.on('create-room', (callback) => {
    try {
      const roomId = roomManager.createRoom();
      socket.data.roomId = roomId;
      callback?.({ ok: true, roomId });
    } catch (err) {
      callback?.({ ok: false, error: (err as Error).message });
    }
  });

  socket.on('join-room', ({ roomId, displayName }, callback) => {
    const room = roomManager.joinRoom(roomId, socket.id, displayName);
    if (!room) {
      callback?.({ ok: false, error: 'Room not found' });
      return;
    }
    socket.data.roomId = roomId;
    socket.join(roomId);
    broadcastNewPeer(room, socket.id);
    broadcastRoster(room);
    callback?.({ ok: true });
  });

  // --- WebRTC signaling relays ---
  // These are forwarded verbatim between peers. The server is a dumb relay.

  socket.on('offer', ({ to, offer }) => {
    io.to(to).emit('offer', { from: socket.id, offer });
  });

  socket.on('answer', ({ to, answer }) => {
    io.to(to).emit('answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  // --- Chat ---
  socket.on('chat-message', ({ roomId, text }) => {
    const sender = roomManager.getRoomForSocket(socket.id);
    if (!sender || sender.id !== roomId) return;
    io.to(roomId).emit('chat-message', {
      from: socket.id,
      senderName: sender.participants.get(socket.id)?.displayName ?? 'Guest',
      text,
      timestamp: Date.now(),
    });
  });

  // --- Media state toggles (mute / camera on/off / screen share) ---
  socket.on('media-state', ({ to, state }) => {
    io.to(to).emit('media-state', { from: socket.id, state });
  });

  socket.on('raise-hand', ({ roomId }) => {
    io.to(roomId).emit('raise-hand', { from: socket.id });
  });

  socket.on('disconnecting', () => {
    const room = roomManager.leaveRoom(socket.id);
    if (room) {
      socket.to(room.id).emit('peer-disconnected', { socketId: socket.id });
      broadcastRoster(room);
    }
  });

  socket.on('disconnect', () => {
    // cleanup handled in 'disconnecting'
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const scheme = tlsCredentials ? 'https' : 'http';
  console.log(`[server] ${scheme} listening on :${PORT} (${NODE_ENV})`);
});
