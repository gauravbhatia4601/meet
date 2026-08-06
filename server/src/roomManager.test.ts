import { describe, it, expect } from 'vitest';
import { roomManager } from './roomManager';

describe('roomManager', () => {
  it('creates a room with a valid, distinct code', () => {
    const id = roomManager.createRoom();
    expect(id).toMatch(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
    expect(roomManager.getRoom(id)).toBeDefined();
  });

  it('generates unique room codes', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const id = roomManager.createRoom();
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });

  it('joinRoom returns null for a nonexistent room', () => {
    expect(roomManager.joinRoom('abc-defg-hij', 'sock1', 'Alice')).toBeNull();
  });

  it('joins participants and assigns the first as host', () => {
    const id = roomManager.createRoom();
    const room = roomManager.joinRoom(id, 'sock1', 'Alice');
    expect(room).not.toBeNull();
    expect(room!.hostId).toBe('sock1');
    expect(roomManager.listParticipants(room!).map((p) => p.displayName)).toEqual(['Alice']);
  });

  it('does not reassign host while the host remains', () => {
    const id = roomManager.createRoom();
    roomManager.joinRoom(id, 'sock1', 'Alice');
    roomManager.joinRoom(id, 'sock2', 'Bob');
    expect(roomManager.getRoom(id)!.hostId).toBe('sock1');
  });

  it('defaults an empty display name to Guest', () => {
    const id = roomManager.createRoom();
    const room = roomManager.joinRoom(id, 'sock1', '   ');
    expect(roomManager.listParticipants(room!)[0].displayName).toBe('Guest');
  });

  it('transfers host to the next participant on leave', () => {
    const id = roomManager.createRoom();
    roomManager.joinRoom(id, 'sock1', 'Alice');
    roomManager.joinRoom(id, 'sock2', 'Bob');
    roomManager.leaveRoom('sock1');
    expect(roomManager.getRoom(id)!.hostId).toBe('sock2');
  });

  it('removes the room when the last participant leaves', () => {
    const id = roomManager.createRoom();
    roomManager.joinRoom(id, 'sock1', 'Alice');
    expect(roomManager.leaveRoom('sock1')).not.toBeNull();
    expect(roomManager.getRoom(id)).toBeUndefined();
  });

  it('leaveRoom is a no-op for an unjoined socket', () => {
    const id = roomManager.createRoom();
    roomManager.joinRoom(id, 'sock1', 'Alice');
    expect(roomManager.leaveRoom('unknown')).toBeNull();
    expect(roomManager.getRoom(id)).toBeDefined();
  });

  it('cleans up socketToRoom on leave', () => {
    const id = roomManager.createRoom();
    roomManager.joinRoom(id, 'sock1', 'Alice');
    roomManager.leaveRoom('sock1');
    expect(roomManager.getRoomIdForSocket('sock1')).toBeNull();
  });
});
