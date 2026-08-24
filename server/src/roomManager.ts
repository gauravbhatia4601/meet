import { randomUUID } from 'node:crypto';
import { createRoomStore, type RoomStore } from './roomStore.js';

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

const DEFAULT_TTL_SECONDS = 604800; // 7 days — a code stays valid this long.

/**
 * Room state is split in two:
 *
 *  - Persisted record (RoomStore / Redis): keeps a meeting code valid even when
 *    nobody is connected, so a link can be reopened later (like Google Meet).
 *  - Live participants (in-memory here): who's connected right now. This is
 *    transient and per-socket; it goes away on disconnect.
 *
 * On join, if the live room isn't in memory (server restarted, or the call had
 * emptied), we recreate it from the persisted record — so rejoining a code that
 * currently has nobody in it still works. The record's TTL is refreshed on
 * every join so an active meeting never expires.
 */
class RoomManager {
  private rooms = new Map<string, Room>();
  private socketToRoom = new Map<string, string>();

  constructor(private store: RoomStore, private ttlSeconds: number) {}

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

  /** Create a new meeting code and persist it. No live room is created yet —
   *  that happens on the first join, which avoids orphaned empty rooms. */
  async createRoom(): Promise<string> {
    const roomId = this.generateRoomId();
    await this.store.set(roomId, { id: roomId, createdAt: Date.now() }, this.ttlSeconds);
    return roomId;
  }

  async joinRoom(roomId: string, socketId: string, displayName: string): Promise<Room | null> {
    let room = this.rooms.get(roomId);
    if (!room) {
      // Live room absent (rejoin after empty / server restart): rebuild it
      // from the persisted record. If there's no record, the code is invalid.
      const record = await this.store.get(roomId);
      if (!record) return null;
      room = { id: record.id, createdAt: record.createdAt, participants: new Map(), hostId: null };
      this.rooms.set(roomId, room);
    }

    const participant: Participant = {
      id: randomUUID(),
      socketId,
      displayName: displayName.trim() || 'Guest',
      joinedAt: Date.now(),
    };
    room.participants.set(socketId, participant);
    if (!room.hostId) room.hostId = socketId;
    this.socketToRoom.set(socketId, roomId);

    // Keep the code alive while the meeting is active.
    void this.store.refresh(roomId, this.ttlSeconds);
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

    // The live session ends when empty, but the persisted code survives in the
    // store (until its TTL) — so the same link can be reopened later.
    if (room.participants.size === 0) {
      this.rooms.delete(room.id);
    }
    return room;
  }

  /** Whether a code resolves to a valid meeting (live OR persisted). */
  async roomExists(roomId: string): Promise<boolean> {
    if (this.rooms.has(roomId)) return true;
    return (await this.store.get(roomId)) !== null;
  }

  /** Permanently remove a code (e.g. host ends the meeting). */
  async deleteRoom(roomId: string): Promise<void> {
    this.rooms.delete(roomId);
    await this.store.delete(roomId);
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

const ttlSeconds = Number(process.env.ROOM_TTL_SECONDS ?? DEFAULT_TTL_SECONDS);

export const roomManager = new RoomManager(createRoomStore(ttlSeconds), ttlSeconds);