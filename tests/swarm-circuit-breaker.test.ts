import { describe, it, expect } from 'vitest';
import { CircuitBreaker, StickyConviction, type Regime } from '../src/orchestrator/swarm-guards.js';

describe('CircuitBreaker (Kernel B — pump-scanner Adapt)', () => {
  it('trips after 3 consecutive failures and stages a cooldown', () => {
    let t = 0;
    const cb = new CircuitBreaker(3, 3_600_000, () => t);
    expect(cb.record(true).tripped).toBe(false);
    expect(cb.record(true).tripped).toBe(false);
    const third = cb.record(true);
    expect(third.cooldownMs).toBe(3_600_000);
    // advance past cooldown -> no longer tripped
    t = 3_600_001;
    expect(cb.record(false).tripped).toBe(false);
  });

  it('a success resets the consecutive-fail counter before the threshold', () => {
    let t = 0;
    const cb = new CircuitBreaker(3, 3_600_000, () => t);
    cb.record(true); // fail 1
    cb.record(true); // fail 2
    cb.record(false); // success resets the counter
    expect(cb.record(true).tripped).toBe(false); // fail 1
    expect(cb.record(true).tripped).toBe(false); // fail 2
    expect(cb.record(true).tripped).toBe(true); // fail 3 -> trip
  });
});

describe('StickyConviction (Kernel B — azimuth A16)', () => {
  it('returns a cached value within TTL and null after it expires', () => {
    let t = 0;
    const sc = new StickyConviction(300_000, () => t);
    expect(sc.get('meme')).toBeNull();
    sc.store('meme', 85);
    expect(sc.get('meme')).toBe(85);
    t = 300_001;
    expect(sc.get('meme')).toBeNull();
  });
});
