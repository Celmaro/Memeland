import { describe, it, expect, vi, afterEach } from 'vitest';
import { MarketSentinel, type MarketSentinelSample } from '../src/services/market-sentinel.js';
import { sentinelRegimeTripsEnabled } from '../src/startup/risk.js';

const regimeOnly: MarketSentinelSample = { botRisk: 0, highRiskFraction: 0, regimeRiskOff: true };
const botOnly: MarketSentinelSample = { botRisk: 95, highRiskFraction: 0.5, regimeRiskOff: false };

describe('sentinelRegimeTripsEnabled env knob', () => {
  const key = 'MARKET_SENTINEL_REGIME_TRIPS';
  afterEach(() => delete process.env[key]);

  it('defaults to off when unset or not literally true', () => {
    expect(sentinelRegimeTripsEnabled()).toBe(false);
    process.env[key] = 'false';
    expect(sentinelRegimeTripsEnabled()).toBe(false);
    process.env[key] = '1';
    expect(sentinelRegimeTripsEnabled()).toBe(false);
  });

  it('enables only with literal true', () => {
    process.env[key] = 'true';
    expect(sentinelRegimeTripsEnabled()).toBe(true);
  });
});

describe('MarketSentinel with regimeRiskOffTrips disabled', () => {
  it('regime risk-off alone never trips; bot-risk still trips', () => {
    const trip = vi.fn();
    const s = new MarketSentinel(() => regimeOnly, trip, { requireConsecutive: 1, cooldownMs: 0, regimeRiskOffTrips: false });
    for (let i = 0; i < 4; i++) s.checkAndReact();
    expect(trip).not.toHaveBeenCalled();

    const s2 = new MarketSentinel(() => botOnly, trip, { requireConsecutive: 1, cooldownMs: 0, regimeRiskOffTrips: false });
    s2.checkAndReact();
    expect(trip).toHaveBeenCalledTimes(1);
  });
});