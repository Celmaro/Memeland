import { describe, expect, it, vi } from 'vitest';
import { TtlCache } from '../src/cache/ttl-cache.js';

describe('KC1 / Kernel L — TtlCache', () => {
  it('returns null for missing key', () => {
    const c = new TtlCache<string>({ ttlMs: 1000 });
    expect(c.get('nope')).toBeNull();
    expect(c.has('nope')).toBe(false);
    expect(c.size()).toBe(0);
  });

  it('returns the stored value while fresh', () => {
    const c = new TtlCache<string>({ ttlMs: 1000, now: () => 100 });
    c.set('k', 'v');
    expect(c.get('k')).toBe('v');
    expect(c.has('k')).toBe(true);
    expect(c.size()).toBe(1);
  });

  it('evicts on read past TTL (lazy)', () => {
    let now = 1000;
    const c = new TtlCache<string>({ ttlMs: 100, now: () => now });
    c.set('k', 'v');
    expect(c.get('k')).toBe('v');
    now = 1101;
    expect(c.get('k')).toBeNull();
    expect(c.size()).toBe(0);
  });

  it('prune() drops stale entries in bulk without touching fresh ones', () => {
    let now = 1000;
    const c = new TtlCache<string>({ ttlMs: 100, now: () => now });
    c.set('a', '1');
    now = 1050;
    c.set('b', '2');
    now = 1120; // a is now stale
    expect(c.prune()).toBe(1);
    expect(c.size()).toBe(1);
    expect(c.has('b')).toBe(true);
  });

  it('honours maxEntries (LRU cap, oldest-first eviction)', () => {
    const c = new TtlCache<string>({ ttlMs: 10000, maxEntries: 2 });
    c.set('a', '1');
    c.set('b', '2');
    c.set('c', '3');
    expect(c.size()).toBe(2);
    expect(c.has('a')).toBe(false);
    expect(c.has('b')).toBe(true);
    expect(c.has('c')).toBe(true);
  });

  it('delete() returns true only for existing keys', () => {
    const c = new TtlCache<string>({ ttlMs: 1000 });
    c.set('k', 'v');
    expect(c.delete('k')).toBe(true);
    expect(c.delete('k')).toBe(false);
    expect(c.size()).toBe(0);
  });

  it('clear() drops everything', () => {
    const c = new TtlCache<string>({ ttlMs: 1000 });
    c.set('a', '1');
    c.set('b', '2');
    c.clear();
    expect(c.size()).toBe(0);
  });

  it('rejects invalid ttlMs', () => {
    expect(() => new TtlCache<string>({ ttlMs: 0 })).toThrow(/ttlMs must be > 0/);
    expect(() => new TtlCache<string>({ ttlMs: -1 })).toThrow(/ttlMs must be > 0/);
  });

  it('overwrite refreshes timestamp (no early eviction on TTL)', () => {
    let now = 1000;
    const c = new TtlCache<string>({ ttlMs: 100, now: () => now });
    c.set('k', 'v1');
    now = 1050;
    c.set('k', 'v2'); // overwrite
    now = 1140; // 90ms after overwrite, 140ms after first set
    expect(c.get('k')).toBe('v2');
  });

  it('now() injection lets tests advance the clock without sleeping', () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const c = new TtlCache<string>({ ttlMs: 100, now: () => now });
      c.set('k', 'v');
      vi.advanceTimersByTime(50);
      now = 50;
      expect(c.get('k')).toBe('v');
      now = 150;
      expect(c.get('k')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});