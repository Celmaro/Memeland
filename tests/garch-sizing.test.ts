import { describe, it, expect } from 'vitest';
import { garchWalkForward, volTargetSize, garchHarnessValidation } from '../src/services/garch-vol.js';

const P = { omega: 0.01, alpha: 0.15, beta: 0.8 };

describe('GARCH walk-forward (Q14)', () => {
  it('vol forecast is bounded and causal (no look-ahead)', () => {
    const returns = [0.1, -0.2, 0.05, 0.4, -0.3, 0.2, -0.1, 0.15, 0.02, -0.05];
    const full = garchWalkForward(returns, P);
    expect(full.vols).toHaveLength(returns.length);
    for (const v of full.vols) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
    expect(Number.isFinite(full.nextVol)).toBe(true);
    // Causality: the first k forecasts must be identical whether computed on the
    // full series or on just the first k+1 observations.
    const prefix = garchWalkForward(returns.slice(0, 5), P);
    expect(full.vols.slice(0, 5)).toEqual(prefix.vols.slice(0, 5));
  });

  it('degenerate (non-stationary) params return an empty guard', () => {
    expect(garchWalkForward([0.1, 0.1], { omega: 1, alpha: 0.6, beta: 0.6 }).vols).toEqual([]);
  });
});

describe('vol-target sizing (Q14)', () => {
  it('reduces notional as forecast vol rises (monotonic, never above base)', () => {
    const base = 1000;
    const low = volTargetSize(base, 20, 20);
    const mid = volTargetSize(base, 40, 20);
    const high = volTargetSize(base, 80, 20);
    expect(low).toBe(1000); // at-target → full
    expect(mid).toBe(500);
    expect(high).toBe(250);
    expect(high).toBeLessThan(mid);
    expect(mid).toBeLessThan(low);
    expect(low).toBeLessThanOrEqual(base);
    // Refuse invalid input.
    expect(volTargetSize(base, 0, 20)).toBe(0);
    expect(volTargetSize(base, NaN, 20)).toBe(0);
  });
});

describe('harness validation (Q14)', () => {
  it('the harness validates the walk-forward honestly', () => {
    const r = garchHarnessValidation(Array.from({ length: 40 }, (_, i) => Math.sin(i * 0.7) * 0.1), P);
    expect(r.valid).toBe(true);
    expect(r.purgedMean).toBeGreaterThan(0);
    // Too few samples cannot be honestly validated (fails open to blocked).
    expect(garchHarnessValidation([0.1, 0.2], P).valid).toBe(false);
  });
});
