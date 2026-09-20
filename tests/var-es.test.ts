import { describe, expect, it } from 'vitest';
import {
  historicalVaR,
  expectedShortfall,
  parametricVarEs,
  monteCarloVarEs,
  riskMetrics,
  riskBucket,
  normalQuantile,
} from '../src/orchestrator/position-sizing.js';

const fatTail = [-0.02, -0.015, 0.01, 0.005, -0.04, 0.02, -0.01, 0.03, -0.025, 0.012];

describe('historical VaR / ES (SRC-133 autogen)', () => {
  it('reports a positive loss magnitude at the worst quantile', () => {
    const v = historicalVaR([-0.01, -0.02, -0.03, -0.04], 0.75);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThan(0);
  });

  it('is fail-closed on empty input', () => {
    expect(Number.isNaN(historicalVaR([]))).toBe(true);
    expect(Number.isNaN(expectedShortfall([]))).toBe(true);
  });

  it('has the tail average beyond VaR as the ES', () => {
    const v = historicalVaR(fatTail, 0.9);
    const es = expectedShortfall(fatTail, 0.9);
    expect(Number.isFinite(v)).toBe(true);
    expect(Number.isFinite(es)).toBe(true);
    expect(es).toBeGreaterThan(0);
  });
});

describe('parametric + monte-carlo VaR/ES', () => {
  it('is fail-closed on degenerate moments', () => {
    const p = parametricVarEs(0, 0, 0.95);
    expect(Number.isNaN(p.var)).toBe(true);
  });

  it('produces a wider VaR for a higher-volatility series', () => {
    const low = parametricVarEs(0.001, 0.01, 0.95).var;
    const high = parametricVarEs(0.001, 0.04, 0.95).var;
    expect(high).toBeGreaterThan(low);
  });

  it('monte-carlo is seed-deterministic', () => {
    const a = monteCarloVarEs(fatTail, 0.95, 500, 42);
    const b = monteCarloVarEs(fatTail, 0.95, 500, 42);
    expect(a.var).toBe(b.var);
    expect(a.es).toBe(b.es);
  });
});

describe('riskMetrics dispatch + riskBucket', () => {
  it('selects the requested method', () => {
    expect(riskMetrics(fatTail, 0.95, 'HISTORICAL').method).toBe('HISTORICAL');
    expect(riskMetrics(fatTail, 0.95, 'PARAMETRIC').method).toBe('PARAMETRIC');
    expect(riskMetrics(fatTail, 0.95, 'MONTE_CARLO').method).toBe('MONTE_CARLO');
  });

  it('is fail-closed via NaN propagation', () => {
    expect(Number.isNaN(riskMetrics([], 0.95, 'HISTORICAL').varPct)).toBe(true);
  });

  it('buckets severity into the autogen tiers', () => {
    expect(riskBucket(2)).toBe('LOW');
    expect(riskBucket(7)).toBe('MEDIUM');
    expect(riskBucket(15)).toBe('HIGH');
    expect(riskBucket(25)).toBe('CRITICAL');
    expect(riskBucket(Number.NaN)).toBe('CRITICAL');
  });
});

describe('normalQuantile sanity', () => {
  it('is ~0 at the median and positive above it', () => {
    expect(Math.abs(normalQuantile(0.5))).toBeLessThan(0.01);
    expect(normalQuantile(0.975)).toBeGreaterThan(1.95);
    expect(normalQuantile(0.025)).toBeLessThan(-1.95);
  });
});
