/**
 * Media Control Handler
 * 
 * Handles media state changes (mic on/off, camera on/off, screen share)
 */

import { TypedSocket } from '../types/index.js';
import { RoomManager } from '../rooms/RoomManager.js';

export function handleMediaState(
  socket: TypedSocket,
  roomManager: RoomManager,
  data: {
    videoEnabled: boolean;
    audioEnabled: boolean;
    screenSharing?: boolean;
  }
): void {
  if (!socket.roomCode) {
    console.warn(`[MediaHandler] Media state from ${socket.id} but not in room`);
    return;
  }

  const room = roomManager.getRoom(socket.roomCode);
  if (!room) return;

  const participant = room.participants.get(socket.id);
  if (!participant) return;

  // Broadcast media state change to other participants
  socket.to(socket.roomCode).emit('media-state-changed', {
    participantId: participant.id,
    peerId: participant.peerId,
    videoEnabled: data.videoEnabled,
    audioEnabled: data.audioEnabled,
    screenSharing: data.screenSharing
  });

  console.log(`[MediaHandler] ${participant.name} changed media state: video=${data.videoEnabled}, audio=${data.audioEnabled}, screen=${data.screenSharing || false}`);
}

export function handleScreenShareStart(
  socket: TypedSocket,
  roomManager: RoomManager
): void {
  if (!socket.roomCode) return;

  const room = roomManager.getRoom(socket.roomCode);
  if (!room) return;

  const participant = room.participants.get(socket.id);
  if (!participant) return;

  // Broadcast screen share start
  socket.to(socket.roomCode).emit('screen-share-started', {
    participantId: participant.id,
    peerId: participant.peerId
  });

  console.log(`[MediaHandler] ${participant.name} started screen sharing`);
}

export function handleScreenShareStop(
  socket: TypedSocket,
  roomManager: RoomManager
): void {
  if (!socket.roomCode) return;

  const room = roomManager.getRoom(socket.roomCode);
  if (!room) return;

  const participant = room.participants.get(socket.id);
  if (!participant) return;

  // Broadcast screen share stop
  socket.to(socket.roomCode).emit('screen-share-stopped', {
    participantId: participant.id,
    peerId: participant.peerId
  });

  console.log(`[MediaHandler] ${participant.name} stopped screen sharing`);
}

