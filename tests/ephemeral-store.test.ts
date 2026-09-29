import { describe, it, expect } from 'vitest';
import {
  InMemoryEphemeralStore,
  RedisEphemeralStore,
  createEphemeralStore,
} from '../src/storage/ephemeral-store.js';

describe('P5/P8 ephemeral store', () => {
  it('in-memory cache honors TTL (mock clock)', async () => {
    let now = 1000;
    const s = new InMemoryEphemeralStore(() => now);
    s.set('price', 12.5, 500);
    expect(s.get<number>('price')).toBe(12.5);
    now = 1499;
    expect(s.get<number>('price')).toBe(12.5); // still valid
    now = 1500;
    expect(s.get<number>('price')).toBeUndefined(); // expired
  });

  it('in-memory del removes an entry and reports presence', () => {
    const s = new InMemoryEphemeralStore();
    s.set('k', 'v', 10000);
    expect(s.del('k')).toBe(true);
    expect(s.get('k')).toBeUndefined();
    expect(s.del('k')).toBe(false);
  });

  it('advisory lock is exclusive until release/expiry', async () => {
    let now = 1000;
    const s = new InMemoryEphemeralStore(() => now);
    expect(await s.acquireLock('research:token-a', 5000)).toBe(true);
    expect(await s.acquireLock('research:token-a', 5000)).toBe(false); // held
    await s.releaseLock('research:token-a');
    expect(await s.acquireLock('research:token-a', 5000)).toBe(true); // re-acquirable
    expect(await s.acquireLock('research:token-b', 1000)).toBe(true);
    now = 2001; // token-b lock expired
    expect(await s.acquireLock('research:token-b', 1000)).toBe(true);
  });

  it('fifo queue round-trips', async () => {
    const s = new InMemoryEphemeralStore();
    expect(await s.dequeue('q')).toBeUndefined();
    expect(await s.enqueue('q', 'a')).toBe(1);
    expect(await s.enqueue('q', 'b')).toBe(2);
    expect(await s.dequeue('q')).toBe('a');
    expect(await s.dequeue('q')).toBe('b');
    expect(await s.dequeue('q')).toBeUndefined();
  });

  it('RedisEphemeralStore without REDIS_URL is mirror-only and fail-open (redisArmed=false)', async () => {
    const r = new RedisEphemeralStore(undefined as unknown as string);
    expect(r.redisArmed()).toBe(false);
    r.set('k', 'v', 10000);
    expect(r.get('k')).toBe('v');
    await r.acquireLock('l', 1000);
    expect(await r.acquireLock('l', 1000)).toBe(false);
    await r.enqueue('q', 'x');
    expect(await r.dequeue('q')).toBe('x');
  });

  it('createEphemeralStore selects in-memory when REDIS_URL is unset', () => {
    const prev = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      const s = createEphemeralStore();
      expect(s).toBeInstanceOf(InMemoryEphemeralStore);
    } finally {
      if (prev !== undefined) process.env.REDIS_URL = prev;
    }
  });

  it('[P8] acquireLock returns the Redis SET NX result (authoritative), mirror NOT consulted', async () => {
    const r = new RedisEphemeralStore('redis://fake');
    (r as unknown as { ensureClient: () => Promise<any> }).ensureClient = async () => ({
      set: async () => 'OK', // NX acquired
    });
    expect(await r.acquireLock('key', 10_000)).toBe(true);
    // Second locker — Redis NX returns null (already held) → authoritative false.
    (r as unknown as { ensureClient: () => Promise<any> }).ensureClient = async () => ({
      set: async () => null,
    });
    expect(await r.acquireLock('key', 10_000)).toBe(false);
  });

  it('[P8] acquireLock fails open to the mirror when Redis is unreachable', async () => {
    const r = new RedisEphemeralStore('redis://fake');
    (r as unknown as { ensureClient: () => Promise<any> }).ensureClient = async () => {
      throw new Error('redis down');
    };
    // No Redis → the process-local mirror grants (best effort), never a throw.
    expect(await r.acquireLock('key', 10_000)).toBe(true);
    // Second attempt: mirror still holds it within TTL.
    expect(await r.acquireLock('key', 10_000)).toBe(false);
  });

  it('[P8] enqueue/dequeue are Redis-authoritative when armed', async () => {
    const r = new RedisEphemeralStore('redis://fake');
    const store: string[] = [];
    (r as unknown as { ensureClient: () => Promise<any> }).ensureClient = async () => ({
      rpush: async (_k: string, v: string) => { store.push(v); return store.length; },
      lpop: async () => store.shift() ?? null,
    });
    expect(await r.enqueue('q', 'a')).toBe(1);
    expect(await r.enqueue('q', 'b')).toBe(2);
    expect(await r.dequeue('q')).toBe('a');
    expect(await r.dequeue('q')).toBe('b');
    expect(await r.dequeue('q')).toBeUndefined();
  });
});