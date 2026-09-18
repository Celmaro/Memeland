import { describe, it, expect, vi } from 'vitest';
import { MarketSentinel, type MarketSentinelSample } from '../src/services/market-sentinel.js';

const calm: MarketSentinelSample = { botRisk: 10, highRiskFraction: 0, regimeRiskOff: false };
const hot: MarketSentinelSample = { botRisk: 90, highRiskFraction: 0.5, regimeRiskOff: false };

describe('MarketSentinel', () => {
  it('never trips on a calm market (consecutive counter stays 0)', () => {
    const trip = vi.fn();
    const sentinel = new MarketSentinel(() => calm, trip, { requireConsecutive: 3 });
    for (let i = 0; i < 5; i++) sentinel.checkAndReact();
    expect(trip).not.toHaveBeenCalled();
    expect(sentinel.getStatus().consecutiveRiskPasses).toBe(0);
    expect(sentinel.getStatus().killSwitchEngagedReason).toBeNull();
  });

  it('trips the kill-switch only after N persistent hot passes', () => {
    const trip = vi.fn();
    const sentinel = new MarketSentinel(() => hot, trip, { requireConsecutive: 3, cooldownMs: 0 });
    sentinel.checkAndReact(); // 1
    sentinel.checkAndReact(); // 2
    expect(trip).not.toHaveBeenCalled();
    sentinel.checkAndReact(); // 3 → trip
    expect(trip).toHaveBeenCalledTimes(1);
    expect(trip.mock.calls[0][0]).toContain('bot-risk 90');
    expect(sentinel.getStatus().killSwitchEngagedReason).toContain('3 persistent');
  });

  it('resets persistence when the market recovers', () => {
    const trip = vi.fn();
    let sample = hot;
    const sentinel = new MarketSentinel(() => sample, trip, { requireConsecutive: 2, cooldownMs: 0 });
    sentinel.checkAndReact(); // 1
    sample = calm;
    sentinel.checkAndReact(); // reset to 0
    expect(sentinel.getStatus().consecutiveRiskPasses).toBe(0);
  });

  it('fail-open: a throwing probe never trips', () => {
    const trip = vi.fn();
    const sentinel = new MarketSentinel(
      () => {
        throw new Error('probe down');
      },
      trip,
      { requireConsecutive: 1, cooldownMs: 0 }
    );
    sentinel.checkAndReact();
    expect(trip).not.toHaveBeenCalled();
    expect(sentinel.getStatus().consecutiveRiskPasses).toBe(0);
  });

  it('respects cooldown so it cannot re-trip in a tight loop', () => {
    const trip = vi.fn();
    const sentinel = new MarketSentinel(() => hot, trip, {
      requireConsecutive: 1,
      cooldownMs: 10_000,
    });
    sentinel.checkAndReact(); // trip
    sentinel.checkAndReact(); // cooldown blocks
    expect(trip).toHaveBeenCalledTimes(1);
  });

  it('exposes status with deep-copied last sample', () => {
    const sentinel = new MarketSentinel(() => hot, vi.fn(), { requireConsecutive: 5 });
    sentinel.checkAndReact();
    const status = sentinel.getStatus();
    expect(status.lastSample).toEqual(hot);
    expect(status.lastCheckedAt).toBeTypeOf('number');
  });
});
