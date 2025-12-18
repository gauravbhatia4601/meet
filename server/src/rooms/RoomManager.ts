/**
 * RoomManager
 * 
 * Manages all meeting rooms and participants
 * Handles room creation, joining, leaving, and cleanup
 */

import { Room, Participant, ParticipantInfo, RoomErrorCode } from '../types/index.js';

export class RoomManager {
  private rooms: Map<string, Room> = new Map();
  private readonly MAX_PARTICIPANTS: number;
  private readonly ROOM_TIMEOUT_MS: number;

  constructor(
    maxParticipants: number = 50,
    roomTimeoutMinutes: number = 60
  ) {
    this.MAX_PARTICIPANTS = maxParticipants;
    this.ROOM_TIMEOUT_MS = roomTimeoutMinutes * 60 * 1000;

    // Cleanup inactive rooms every 5 minutes
    setInterval(() => this.cleanupInactiveRooms(), 5 * 60 * 1000);
  }

  /**
   * Create a new room
   */
  createRoom(roomCode: string, hostSocketId: string, hostPeerId: string, hostName: string): Room {
    if (this.rooms.has(roomCode)) {
      throw new Error(`Room ${roomCode} already exists`);
    }

    const host: Participant = {
      id: hostSocketId,
      peerId: hostPeerId,
      name: hostName,
      isHost: true,
      joinedAt: Date.now()
    };

    const room: Room = {
      code: roomCode,
      hostId: hostSocketId,
      participants: new Map([[hostSocketId, host]]),
      createdAt: Date.now(),
      lastActivity: Date.now()
    };

    this.rooms.set(roomCode, room);
    console.log(`[RoomManager] Created room: ${roomCode} by host ${hostName} (${hostSocketId})`);

    return room;
  }

  /**
   * Join an existing room
   */
  joinRoom(
    roomCode: string,
    socketId: string,
    peerId: string,
    name: string
  ): { room: Room; participant: Participant } {
    const room = this.rooms.get(roomCode);

    if (!room) {
      throw new Error(RoomErrorCode.ROOM_NOT_FOUND);
    }

    // Check if room is full
    if (room.participants.size >= this.MAX_PARTICIPANTS) {
      throw new Error(RoomErrorCode.ROOM_FULL);
    }

    // Check if already in room (shouldn't happen, but safety check)
    if (room.participants.has(socketId)) {
      const existing = room.participants.get(socketId)!;
      return { room, participant: existing };
    }

    // Create participant
    const participant: Participant = {
      id: socketId,
      peerId,
      name: name.trim() || `Guest ${socketId.slice(0, 6)}`,
      isHost: false,
      joinedAt: Date.now()
    };

    // Add to room
    room.participants.set(socketId, participant);
    room.lastActivity = Date.now();

    console.log(`[RoomManager] ${participant.name} (${socketId}) joined room ${roomCode}`);

    return { room, participant };
  }

  /**
   * Leave a room
   */
  leaveRoom(roomCode: string, socketId: string): { room: Room | null; wasHost: boolean; newHostId?: string } {
    const room = this.rooms.get(roomCode);

    if (!room) {
      return { room: null, wasHost: false };
    }

    const participant = room.participants.get(socketId);
    if (!participant) {
      return { room: null, wasHost: false };
    }

    const wasHost = participant.isHost;
    room.participants.delete(socketId);
    room.lastActivity = Date.now();

    console.log(`[RoomManager] ${participant.name} (${socketId}) left room ${roomCode}`);

    // If host left and there are other participants, assign new host
    let newHostId: string | undefined;
    if (wasHost && room.participants.size > 0) {
      // Assign first participant as new host
      const newHost = Array.from(room.participants.values())[0];
      newHost.isHost = true;
      room.hostId = newHost.id;
      newHostId = newHost.id;
      console.log(`[RoomManager] Assigned new host: ${newHost.name} (${newHost.id}) for room ${roomCode}`);
    }

    // Delete room if empty
    if (room.participants.size === 0) {
      this.rooms.delete(roomCode);
      console.log(`[RoomManager] Deleted empty room: ${roomCode}`);
      return { room: null, wasHost, newHostId };
    }

    return { room, wasHost, newHostId };
  }

  /**
   * Get room by code
   */
  getRoom(roomCode: string): Room | undefined {
    return this.rooms.get(roomCode);
  }

  /**
   * Get participant in room
   */
  getParticipant(roomCode: string, socketId: string): Participant | undefined {
    const room = this.rooms.get(roomCode);
    return room?.participants.get(socketId);
  }

  /**
   * Get all participants in room as array (for client)
   */
  getParticipantsList(roomCode: string): ParticipantInfo[] {
    const room = this.rooms.get(roomCode);
    if (!room) return [];

    return Array.from(room.participants.values()).map(p => ({
      id: p.id,
      peerId: p.peerId,
      name: p.name,
      isHost: p.isHost
    }));
  }

  /**
   * Update room activity timestamp
   */
  updateActivity(roomCode: string): void {
    const room = this.rooms.get(roomCode);
    if (room) {
      room.lastActivity = Date.now();
    }
  }

  /**
   * Get all rooms (for debugging/admin)
   */
  getAllRooms(): Room[] {
    return Array.from(this.rooms.values());
  }

  /**
   * Cleanup inactive rooms
   */
  private cleanupInactiveRooms(): void {
    const now = Date.now();
    const roomsToDelete: string[] = [];

    for (const [code, room] of this.rooms.entries()) {
      // Delete if inactive for timeout period
      if (now - room.lastActivity > this.ROOM_TIMEOUT_MS) {
        roomsToDelete.push(code);
      }
    }

    for (const code of roomsToDelete) {
      this.rooms.delete(code);
      console.log(`[RoomManager] Cleaned up inactive room: ${code}`);
    }

    if (roomsToDelete.length > 0) {
      console.log(`[RoomManager] Cleaned up ${roomsToDelete.length} inactive room(s)`);
    }
  }

  /**
   * Get room statistics (for monitoring)
   */
  getStats(): {
    totalRooms: number;
    totalParticipants: number;
    roomsBySize: Record<string, number>;
  } {
    const stats = {
      totalRooms: this.rooms.size,
      totalParticipants: 0,
      roomsBySize: {} as Record<string, number>
    };

    for (const room of this.rooms.values()) {
      stats.totalParticipants += room.participants.size;
      const size = room.participants.size.toString();
      stats.roomsBySize[size] = (stats.roomsBySize[size] || 0) + 1;
    }

    return stats;
  }
}

