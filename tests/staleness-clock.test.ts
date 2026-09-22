import { describe, it, expect, vi } from 'vitest';
import { StalenessClock } from '../src/clock/staleness-clock.js';

describe('KC4 / Kernel O — StalenessClock', () => {
  it('rejects ttlMs <= 0', () => {
    expect(() => new StalenessClock({ ttlMs: 0 })).toThrow(/ttlMs must be > 0/);
    expect(() => new StalenessClock({ ttlMs: -100 })).toThrow(/ttlMs must be > 0/);
  });

  it('starts stale (untouched)', () => {
    const c = new StalenessClock({ ttlMs: 1000, now: () => 0 });
    expect(c.isStale()).toBe(true);
    expect(c.ageMs()).toBeNull();
    expect(c.lastTouched).toBeNull();
  });

  it('touch() then isStale() within TTL returns false', () => {
    let now = 100;
    const c = new StalenessClock({ ttlMs: 1000, now: () => now });
    c.touch();
    now = 500;
    expect(c.isStale()).toBe(false);
    expect(c.ageMs()).toBe(400);
  });

  it('isStale() past TTL returns true', () => {
    let now = 0;
    const c = new StalenessClock({ ttlMs: 1000, now: () => now });
    c.touch();
    now = 1001;
    expect(c.isStale()).toBe(true);
    expect(c.ageMs()).toBe(1001);
  });

  it('touch(at) accepts an explicit timestamp', () => {
    const c = new StalenessClock({ ttlMs: 1000, now: () => 5000 });
    c.touch(100);
    expect(c.lastTouched).toBe(100);
    expect(c.ageMs()).toBe(4900);
  });

  it('isStale(at) probes the past', () => {
    const c = new StalenessClock({ ttlMs: 1000, now: () => 1000 });
    c.touch(500);
    expect(c.isStale(1501)).toBe(true);
    expect(c.isStale(1500)).toBe(false); // boundary: equal is fresh
  });
});