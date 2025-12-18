/**
 * Chat Handler
 * 
 * Handles chat messages in rooms
 */

import { TypedSocket } from '../types/index.js';
import { RoomManager } from '../rooms/RoomManager.js';

export function handleChatMessage(
  socket: TypedSocket,
  roomManager: RoomManager,
  data: {
    message: string;
  }
): void {
  if (!socket.roomCode) {
    console.warn(`[ChatHandler] Chat message from ${socket.id} but not in room`);
    return;
  }

  const room = roomManager.getRoom(socket.roomCode);
  if (!room) return;

  const participant = room.participants.get(socket.id);
  if (!participant) return;

  // Validate message
  if (!data.message || typeof data.message !== 'string' || data.message.trim().length === 0) {
    return;
  }

  // Limit message length
  const message = data.message.trim().slice(0, 1000);

  // Broadcast to all participants in room (including sender for consistency)
  socket.to(socket.roomCode).emit('chat-message', {
    from: participant.id,
    fromName: participant.name,
    message,
    timestamp: Date.now()
  });

  console.log(`[ChatHandler] ${participant.name}: ${message.slice(0, 50)}...`);
}

