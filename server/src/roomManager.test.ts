import { describe, it, expect } from 'vitest';
import { roomManager } from './roomManager';

describe('roomManager', () => {
  it('creates a room with a valid, distinct code (persisted, not yet live)', async () => {
    const id = await roomManager.createRoom();
    expect(id).toMatch(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
    // The code is valid (persisted), but no live session exists until someone joins.
    expect(roomManager.getRoom(id)).toBeUndefined();
    expect(await roomManager.roomExists(id)).toBe(true);
  });

  it('generates unique room codes', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const id = await roomManager.createRoom();
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });

  it('joinRoom returns null for a nonexistent room', async () => {
    expect(await roomManager.joinRoom('abc-defg-hij', 'sock1', 'Alice')).toBeNull();
  });

  it('joins participants and assigns the first as host', async () => {
    const id = await roomManager.createRoom();
    const room = await roomManager.joinRoom(id, 'sock1', 'Alice');
    expect(room).not.toBeNull();
    expect(room!.hostId).toBe('sock1');
    expect(roomManager.listParticipants(room!).map((p) => p.displayName)).toEqual(['Alice']);
  });

  it('does not reassign host while the host remains', async () => {
    const id = await roomManager.createRoom();
    await roomManager.joinRoom(id, 'sock1', 'Alice');
    await roomManager.joinRoom(id, 'sock2', 'Bob');
    expect(roomManager.getRoom(id)!.hostId).toBe('sock1');
  });

  it('defaults an empty display name to Guest', async () => {
    const id = await roomManager.createRoom();
    const room = await roomManager.joinRoom(id, 'sock1', '   ');
    expect(roomManager.listParticipants(room!)[0].displayName).toBe('Guest');
  });

  it('transfers host to the next participant on leave', async () => {
    const id = await roomManager.createRoom();
    await roomManager.joinRoom(id, 'sock1', 'Alice');
    await roomManager.joinRoom(id, 'sock2', 'Bob');
    roomManager.leaveRoom('sock1');
    expect(roomManager.getRoom(id)!.hostId).toBe('sock2');
  });

  it('ends the live session when the last participant leaves, but keeps the code valid', async () => {
    const id = await roomManager.createRoom();
    await roomManager.joinRoom(id, 'sock1', 'Alice');
    expect(roomManager.leaveRoom('sock1')).not.toBeNull();
    // Live session gone...
    expect(roomManager.getRoom(id)).toBeUndefined();
    // ...but the persisted code can still be rejoined (the Google-Meet behavior).
    expect(await roomManager.roomExists(id)).toBe(true);
    const rejoined = await roomManager.joinRoom(id, 'sock2', 'Bob');
    expect(rejoined).not.toBeNull();
    expect(roomManager.getRoom(id)).toBeDefined();
  });

  it('leaveRoom is a no-op for an unjoined socket', async () => {
    const id = await roomManager.createRoom();
    await roomManager.joinRoom(id, 'sock1', 'Alice');
    expect(roomManager.leaveRoom('unknown')).toBeNull();
    expect(roomManager.getRoom(id)).toBeDefined();
  });

  it('cleans up socketToRoom on leave', async () => {
    const id = await roomManager.createRoom();
    await roomManager.joinRoom(id, 'sock1', 'Alice');
    roomManager.leaveRoom('sock1');
    expect(roomManager.getRoomIdForSocket('sock1')).toBeNull();
  });
});