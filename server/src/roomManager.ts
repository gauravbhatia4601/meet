import { randomUUID } from 'node:crypto';

export interface Participant {
  id: string;
  socketId: string;
  displayName: string;
  joinedAt: number;
}

export interface Room {
  id: string;
  createdAt: number;
  participants: Map<string, Participant>;
  hostId: string | null;
}

/**
 * In-memory room store. For horizontal scaling across multiple server
 * instances this should be replaced with a shared store (Redis/pub-sub).
 * Each entry is keyed by socketId -> roomId to enable fast lookups.
 */
class RoomManager {
  private rooms = new Map<string, Room>();
  private socketToRoom = new Map<string, string>();

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  getRoomForSocket(socketId: string): Room | undefined {
    const roomId = this.socketToRoom.get(socketId);
    return roomId ? this.rooms.get(roomId) : undefined;
  }

  getRoomIdForSocket(socketId: string): string | null {
    return this.socketToRoom.get(socketId) ?? null;
  }

  createRoom(): string {
    const roomId = this.generateRoomId();
    this.rooms.set(roomId, {
      id: roomId,
      createdAt: Date.now(),
      participants: new Map(),
      hostId: null,
    });
    return roomId;
  }

  joinRoom(roomId: string, socketId: string, displayName: string): Room | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    const participant: Participant = {
      id: randomUUID(),
      socketId,
      displayName: displayName.trim() || 'Guest',
      joinedAt: Date.now(),
    };
    room.participants.set(socketId, participant);
    if (!room.hostId) room.hostId = socketId;
    this.socketToRoom.set(socketId, roomId);
    return room;
  }

  leaveRoom(socketId: string): Room | null {
    const room = this.getRoomForSocket(socketId);
    if (!room) return null;

    room.participants.delete(socketId);
    this.socketToRoom.delete(socketId);

    if (room.hostId === socketId) {
      const nextHost = room.participants.values().next().value;
      room.hostId = nextHost ? nextHost.socketId : null;
    }

    // Clean up empty rooms to avoid unbounded memory growth.
    if (room.participants.size === 0) {
      this.rooms.delete(room.id);
    }
    return room;
  }

  listParticipants(room: Room): Participant[] {
    return Array.from(room.participants.values());
  }

  /** Generate a short, human-friendly room code like "abc-defg-hij". */
  private generateRoomId(): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz';
    const segment = (len: number) =>
      Array.from({ length: len }, () =>
        alphabet[Math.floor(Math.random() * alphabet.length)]
      ).join('');
    return `${segment(3)}-${segment(4)}-${segment(3)}`;
  }
}

export const roomManager = new RoomManager();
