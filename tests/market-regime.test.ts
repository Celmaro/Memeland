import { describe, it, expect } from 'vitest';
import { MarketRegimeFilter, computeWhaleRiskOff } from '../src/services/market-regime.js';

describe('computeWhaleRiskOff — Hyperliquid ETH whale net positioning → risk-off', () => {
  it('no data (both zero) is NOT risk-off (fail-open, never over-trigger)', () => {
    const r = computeWhaleRiskOff(0, 0);
    expect(r.riskOff).toBe(false);
    expect(r.netUsd).toBe(0);
  });

  it('net-long whale book is NOT risk-off', () => {
    const r = computeWhaleRiskOff(8_000_000, 3_000_000);
    expect(r.riskOff).toBe(false);
    expect(r.netUsd).toBe(5_000_000);
  });

  it('short-dominated whale book (>= 60% short) is risk-off', () => {
    const r = computeWhaleRiskOff(4_000_000, 9_000_000); // short share = 9/13 = 69%
    expect(r.riskOff).toBe(true);
    expect(r.netUsd).toBe(-5_000_000);
  });

  it('mild short majority does not trip risk-off (below threshold)', () => {
    const r = computeWhaleRiskOff(5_000_000, 6_000_000); // short share = 6/11 = 55%
    expect(r.riskOff).toBe(false);
  });
});

describe('MarketRegimeFilter.setWhaleRiskOff', () => {
  it('records the whale risk-off flag without clobbering the macro regime type', () => {
    const filter = new MarketRegimeFilter();
    filter.updateMarketRegime(5, 6, 30); // TRENDING_BULL
    filter.setWhaleRiskOff(true, 'whales net short');
    const status = filter.getRegime();
    expect(status.regime).toBe('TRENDING_BULL');
    expect(status.whaleRiskOff).toBe(true);
    expect(status.whaleRiskOffReason).toBe('whales net short');
  });

  it('clears the flag when the risk-off signal ends', () => {
    const filter = new MarketRegimeFilter();
    filter.setWhaleRiskOff(true);
    filter.setWhaleRiskOff(false);
    expect(filter.getRegime().whaleRiskOff).toBe(false);
  });
});
