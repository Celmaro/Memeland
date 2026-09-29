import { describe, it, expect } from 'vitest';
import {
  InMemoryEphemeralStore,
  RedisEphemeralStore,
  createEphemeralStore,
} from '../src/storage/ephemeral-store.js';

describe('P5 ephemeral store', () => {
  it('in-memory cache honors TTL (mock clock)', () => {
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

  it('advisory lock is exclusive until release/expiry', () => {
    let now = 1000;
    const s = new InMemoryEphemeralStore(() => now);
    expect(s.acquireLock('research:token-a', 5000)).toBe(true);
    expect(s.acquireLock('research:token-a', 5000)).toBe(false); // held
    s.releaseLock('research:token-a');
    expect(s.acquireLock('research:token-a', 5000)).toBe(true); // re-acquirable
    expect(s.acquireLock('research:token-b', 1000)).toBe(true);
    now = 2001; // token-b lock expired
    expect(s.acquireLock('research:token-b', 1000)).toBe(true);
  });

  it('fifo queue round-trips', () => {
    const s = new InMemoryEphemeralStore();
    expect(s.dequeue('q')).toBeUndefined();
    expect(s.enqueue('q', 'a')).toBe(1);
    expect(s.enqueue('q', 'b')).toBe(2);
    expect(s.dequeue('q')).toBe('a');
    expect(s.dequeue('q')).toBe('b');
    expect(s.dequeue('q')).toBeUndefined();
  });

  it('RedisEphemeralStore without REDIS_URL is mirror-only and fail-open (redisArmed=false)', () => {
    const r = new RedisEphemeralStore(undefined as unknown as string);
    expect(r.redisArmed()).toBe(false);
    r.set('k', 'v', 10000);
    expect(r.get('k')).toBe('v');
    r.acquireLock('l', 1000);
    expect(r.acquireLock('l', 1000)).toBe(false);
    r.enqueue('q', 'x');
    expect(r.dequeue('q')).toBe('x');
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
});