import { describe, it, expect } from 'vitest';
import { computeRubric, securityMetricFactors } from '../src/services/risk-rubric.js';

describe('Risk rubric (Q12)', () => {
  it('lists per-factor deductions and an overall score', () => {
    const r = computeRubric([
      { name: 'concentration', weight: 0.3, score01: 1 },
      { name: 'liquidity', weight: 0.3, score01: 1 },
    ]);
    expect(r.factors).toHaveLength(2);
    expect(r.factors[0]!.deduction).toBe(0);
    expect(r.overall).toBe(100);
    expect(r.clean).toBe(true);
  });

  it('a missing required factor cannot yield a clean score', () => {
    const r = computeRubric([
      { name: 'concentration', weight: 0.3, score01: NaN, required: true },
      { name: 'liquidity', weight: 0.3, score01: 1 },
    ]);
    expect(r.clean).toBe(false);
    // Missing required factor is treated with caution (score counted as 0).
    expect(r.overall).toBeLessThan(100);
  });

  it('concentration/spike/volatility inputs move the security verdict as documented', () => {
    const safe = computeRubric(securityMetricFactors({ concentration: 0.05, spikePct: 10, volatility: 15, liquidityUsd: 500_000 }));
    const risky = computeRubric(securityMetricFactors({ concentration: 0.9, spikePct: 400, volatility: 95, liquidityUsd: 500 }));
    expect(safe.overall).toBeGreaterThan(risky.overall);
    expect(safe.clean).toBe(true);
    // Missing liquidity (required) fails open to caution.
    const noLiquidity = computeRubric(securityMetricFactors({ concentration: 0.1, spikePct: 10, volatility: 15 }));
    expect(noLiquidity.clean).toBe(false);
  });
});
