import { Redis } from 'ioredis';

/**
 * A persisted room record — what makes a meeting code stay valid even when
 * nobody is connected (so a link can be reopened days later, like Google Meet).
 * Live participants are NOT stored here; they live in-memory in RoomManager.
 */
export interface RoomRecord {
  id: string;
  createdAt: number;
}

export interface RoomStore {
  /** Read the persisted record for a code, or null if it never existed / expired. */
  get(roomId: string): Promise<RoomRecord | null>;
  /** Create/overwrite the record and (re)start its TTL. */
  set(roomId: string, record: RoomRecord, ttlSeconds: number): Promise<void>;
  /** Refresh the TTL on an existing record (call on every join). */
  refresh(roomId: string, ttlSeconds: number): Promise<void>;
  /** Remove the record (e.g. host ends the meeting). */
  delete(roomId: string): Promise<void>;
  close(): Promise<void>;
}

const KEY = (roomId: string) => `uplink:room:${roomId}`;

/** Redis-backed store. TTL gives automatic cleanup of stale codes. */
export class RedisRoomStore implements RoomStore {
  private client: Redis;

  constructor(url: string) {
    this.client = new Redis(url, {
      // Don't crash the process on connection errors; RoomManager falls back
      // to "room not found" so the client gets a clear error instead of a hang.
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
    });
    this.client.on('error', (err: Error) => {
      console.error('[roomstore] redis error', err.message);
    });
    this.client.on('connect', () => console.log('[roomstore] redis connected'));
  }

  async get(roomId: string): Promise<RoomRecord | null> {
    const raw = await this.client.get(KEY(roomId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as RoomRecord;
    } catch {
      return null;
    }
  }

  async set(roomId: string, record: RoomRecord, ttlSeconds: number): Promise<void> {
    await this.client.set(KEY(roomId), JSON.stringify(record), 'EX', ttlSeconds);
  }

  async refresh(roomId: string, ttlSeconds: number): Promise<void> {
    // Only extend if the key still exists (expire ... NX would error on missing;
    // `expire` on a missing key returns 0, which is fine here).
    await this.client.expire(KEY(roomId), ttlSeconds);
  }

  async delete(roomId: string): Promise<void> {
    await this.client.del(KEY(roomId));
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}

/**
 * In-memory fallback used when REDIS_URL is not set (local dev). Codes do NOT
 * survive a server restart or an empty room here — that's the persistence gap
 * Redis fills in production.
 */
export class MemoryRoomStore implements RoomStore {
  private records = new Map<string, { record: RoomRecord; expiresAt: number }>();

  constructor(private ttlSeconds: number) {}

  private clean(roomId: string) {
    const entry = this.records.get(roomId);
    if (entry && entry.expiresAt < Date.now()) this.records.delete(roomId);
  }

  async get(roomId: string): Promise<RoomRecord | null> {
    this.clean(roomId);
    return this.records.get(roomId)?.record ?? null;
  }

  async set(roomId: string, record: RoomRecord, ttlSeconds: number): Promise<void> {
    this.records.set(roomId, { record, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async refresh(roomId: string, ttlSeconds: number): Promise<void> {
    const entry = this.records.get(roomId);
    if (entry) entry.expiresAt = Date.now() + ttlSeconds * 1000;
  }

  async delete(roomId: string): Promise<void> {
    this.records.delete(roomId);
  }

  async close(): Promise<void> {}
}

/**
 * Pick a store based on REDIS_URL. With no URL, fall back to in-memory so
 * `npm run dev` works without a Redis instance.
 */
export function createRoomStore(ttlSeconds: number): RoomStore {
  const url = process.env.REDIS_URL?.trim();
  if (url) {
    console.log(`[roomstore] using redis (ttl ${ttlSeconds}s)`);
    return new RedisRoomStore(url);
  }
  console.log(`[roomstore] REDIS_URL unset — using in-memory (no persistence across restarts)`);
  return new MemoryRoomStore(ttlSeconds);
}