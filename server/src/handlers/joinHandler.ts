/**
 * Join Room Handler
 * 
 * Handles joining and creating rooms
 */

import { TypedSocket, RoomErrorCode } from '../types/index.js';
import { RoomManager } from '../rooms/RoomManager.js';

export function handleJoinRoom(
  socket: TypedSocket,
  roomManager: RoomManager,
  data: {
    roomCode: string;
    peerId: string;
    name: string;
    isHost?: boolean;
  }
): void {
  const { roomCode, peerId, name } = data;

  // Validation
  if (!roomCode || typeof roomCode !== 'string') {
    socket.emit('room-error', {
      code: RoomErrorCode.INVALID_ROOM_CODE,
      message: 'Room code is required'
    });
    return;
  }

  if (!peerId || typeof peerId !== 'string') {
    socket.emit('room-error', {
      code: RoomErrorCode.PEER_ID_REQUIRED,
      message: 'Peer ID is required'
    });
    return;
  }

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    socket.emit('room-error', {
      code: RoomErrorCode.NAME_REQUIRED,
      message: 'Name is required'
    });
    return;
  }

  // Normalize room code
  const normalizedCode = roomCode.trim().toLowerCase();

  try {
    // Check if already in a room
    if (socket.roomCode) {
      socket.emit('room-error', {
        code: RoomErrorCode.ALREADY_IN_ROOM,
        message: 'Already in a room. Leave first.'
      });
      return;
    }

    let room;
    let participant;
    const isHost = data.isHost || false;

    if (isHost) {
      // Create new room
      room = roomManager.createRoom(normalizedCode, socket.id, peerId, name.trim());
      participant = room.participants.get(socket.id)!;
    } else {
      // Join existing room
      const result = roomManager.joinRoom(normalizedCode, socket.id, peerId, name.trim());
      room = result.room;
      participant = result.participant;
    }

    // Store room info in socket
    socket.roomCode = normalizedCode;
    socket.participantId = socket.id;

    // Join Socket.io room (for broadcasting)
    socket.join(normalizedCode);

    // Send success response to joiner
    socket.emit('room-joined', {
      roomCode: normalizedCode,
      isHost: participant.isHost,
      participants: roomManager.getParticipantsList(normalizedCode)
    });

    // Notify other participants
    if (!isHost) {
      socket.to(normalizedCode).emit('participant-joined', {
        participant: {
          id: participant.id,
          peerId: participant.peerId,
          name: participant.name,
          isHost: participant.isHost
        }
      });
    }

    // Update all participants list for everyone in room
    socket.to(normalizedCode).emit('participants-update', {
      participants: roomManager.getParticipantsList(normalizedCode)
    });

    console.log(`[JoinHandler] ${participant.name} joined room ${normalizedCode} as ${isHost ? 'host' : 'guest'}`);

  } catch (error: any) {
    console.error(`[JoinHandler] Error joining room ${normalizedCode}:`, error);

    let errorCode = RoomErrorCode.SERVER_ERROR;
    let errorMessage = 'Failed to join room';

    if (error.message === RoomErrorCode.ROOM_NOT_FOUND) {
      errorCode = RoomErrorCode.ROOM_NOT_FOUND;
      errorMessage = 'Room not found';
    } else if (error.message === RoomErrorCode.ROOM_FULL) {
      errorCode = RoomErrorCode.ROOM_FULL;
      errorMessage = 'Room is full';
    }

    socket.emit('room-error', {
      code: errorCode,
      message: errorMessage
    });
  }
}

