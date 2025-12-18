/**
 * Disconnect Handler
 * 
 * Handles client disconnections and cleanup
 */

import { TypedSocket } from '../types/index.js';
import { RoomManager } from '../rooms/RoomManager.js';

export function handleDisconnect(
  socket: TypedSocket,
  roomManager: RoomManager
): void {
  if (!socket.roomCode) {
    console.log(`[DisconnectHandler] Socket ${socket.id} disconnected (not in room)`);
    return;
  }

  const room = roomManager.getRoom(socket.roomCode);
  if (!room) {
    console.log(`[DisconnectHandler] Socket ${socket.id} disconnected (room ${socket.roomCode} not found)`);
    return;
  }

  const participant = room.participants.get(socket.id);
  if (!participant) {
    console.log(`[DisconnectHandler] Socket ${socket.id} disconnected (participant not found)`);
    return;
  }

  const wasHost = participant.isHost;

  // Leave room
  const { newHostId } = roomManager.leaveRoom(
    socket.roomCode,
    socket.id
  );

  // Notify other participants
  socket.to(socket.roomCode).emit('participant-left', {
    participantId: participant.id,
    peerId: participant.peerId
  });

  // Update participants list
  const updatedParticipants = roomManager.getParticipantsList(socket.roomCode);
  if (updatedParticipants.length > 0) {
    socket.to(socket.roomCode).emit('participants-update', {
      participants: updatedParticipants
    });
  }

  // If host changed, notify new host
  if (newHostId) {
    // New host will be notified via participants-update event
    console.log(`[DisconnectHandler] New host assigned: ${newHostId}`);
  }

  console.log(`[DisconnectHandler] ${participant.name} (${socket.id}) disconnected from room ${socket.roomCode}${wasHost ? ' (was host)' : ''}`);
}

