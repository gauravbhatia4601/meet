/**
 * Nebula Meet Signaling Server
 * 
 * WebSocket-based signaling server for WebRTC connections
 * Uses Socket.io for real-time communication
 */

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';

import { RoomManager } from './rooms/RoomManager.js';
import { TypedSocket } from './types/index.js';

// Handlers
import { handleJoinRoom } from './handlers/joinHandler.js';
import { handleWebRTCOffer, handleWebRTCAnswer, handleWebRTCIceCandidate } from './handlers/signalingHandler.js';
import { handleMediaState, handleScreenShareStart, handleScreenShareStop } from './handlers/mediaHandler.js';
import { handleChatMessage } from './handlers/chatHandler.js';
import { handleDisconnect } from './handlers/disconnectHandler.js';

// Load environment variables
dotenv.config();

const app = express();
const httpServer = createServer(app);

// CORS configuration
const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:5173';
app.use(cors({
  origin: corsOrigin,
  credentials: true
}));

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Stats endpoint (for monitoring)
app.get('/stats', (_req, res) => {
  res.json(roomManager.getStats());
});

// Initialize Socket.io
const io = new Server(httpServer, {
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST'],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Initialize Room Manager
const maxParticipants = parseInt(process.env.MAX_PARTICIPANTS_PER_ROOM || '50', 10);
const roomTimeoutMinutes = parseInt(process.env.ROOM_TIMEOUT_MINUTES || '60', 10);
const roomManager = new RoomManager(maxParticipants, roomTimeoutMinutes);

// Socket.io connection handler
io.on('connection', (socket: TypedSocket) => {
  console.log(`[Server] Client connected: ${socket.id}`);

  // Join room
  socket.on('join-room', (data) => {
    handleJoinRoom(socket, roomManager, data);
  });

  // Leave room
  socket.on('leave-room', () => {
    if (socket.roomCode) {
      const room = roomManager.getRoom(socket.roomCode);
      if (room) {
        const participant = room.participants.get(socket.id);
        if (participant) {
          handleDisconnect(socket, roomManager);
          socket.leave(socket.roomCode);
          socket.roomCode = undefined;
          socket.participantId = undefined;
          socket.emit('room-left');
        }
      }
    }
  });

  // WebRTC signaling
  socket.on('webrtc-offer', (data) => {
    handleWebRTCOffer(socket, roomManager, data);
  });

  socket.on('webrtc-answer', (data) => {
    handleWebRTCAnswer(socket, roomManager, data);
  });

  socket.on('webrtc-ice-candidate', (data) => {
    handleWebRTCIceCandidate(socket, roomManager, data);
  });

  // Media control
  socket.on('media-state', (data) => {
    handleMediaState(socket, roomManager, data);
  });

  socket.on('screen-share-start', () => {
    handleScreenShareStart(socket, roomManager);
  });

  socket.on('screen-share-stop', () => {
    handleScreenShareStop(socket, roomManager);
  });

  // Chat
  socket.on('chat-message', (data) => {
    handleChatMessage(socket, roomManager, data);
  });

  // Disconnect
  socket.on('disconnect', () => {
    handleDisconnect(socket, roomManager);
  });

  // Error handling
  socket.on('error', (error) => {
    console.error(`[Server] Socket error for ${socket.id}:`, error);
  });
});

// Start server
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`\n🚀 Nebula Meet Signaling Server running on port ${PORT}`);
  console.log(`📡 CORS enabled for: ${corsOrigin}`);
  console.log(`👥 Max participants per room: ${maxParticipants}`);
  console.log(`⏱️  Room timeout: ${roomTimeoutMinutes} minutes`);
  console.log(`\n📊 Health check: http://localhost:${PORT}/health`);
  console.log(`📈 Stats: http://localhost:${PORT}/stats\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received, shutting down gracefully...');
  httpServer.close(() => {
    console.log('[Server] Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\n[Server] SIGINT received, shutting down gracefully...');
  httpServer.close(() => {
    console.log('[Server] Server closed');
    process.exit(0);
  });
});

