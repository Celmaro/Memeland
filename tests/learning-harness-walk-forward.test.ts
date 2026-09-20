import { describe, expect, it } from 'vitest';
import {
  sharpeRatio,
  walkForwardFolds,
  walkForwardVerdict,
} from '../src/orchestrator/learning-harness.js';

describe('walkForwardFolds (SRC-058 tradingview-mcp walk-forward)', () => {
  it('is fail-closed on undersized input', () => {
    const r = walkForwardFolds([], 5);
    expect(r.folds).toEqual([]);
    expect(r.verdict).toBe('OVERFITTED');
    expect(Number.isNaN(r.ratio)).toBe(true);
  });

  it('never lets the validation fold leak into training (chronological order)', () => {
    // Monotonic drift produces a positive edge; the first validation block is
    // strictly after all training data it is measured against.
    const returns: number[] = [];
    for (let i = 0; i < 50; i++) returns.push(0.02 + i * 0.001);
    const r = walkForwardFolds(returns, 5);
    expect(r.folds.length).toBeGreaterThan(0);
    for (const fold of r.folds) {
      expect(Number.isFinite(fold.inSampleSharpe)).toBe(true);
      expect(Number.isFinite(fold.outOfSampleSharpe)).toBe(true);
    }
    expect(r.verdict).not.toBe('OVERFITTED');
  });

  it('reports OVERFITTED when the in-sample edge is non-positive', () => {
    const returns = [0.01, -0.01, 0.01, -0.01, 0.01, -0.01, 0.01, -0.01];
    const r = walkForwardFolds(returns, 4);
    expect(r.verdict).toBe('OVERFITTED');
    expect(r.meanInSampleSharpe).toBeLessThanOrEqual(0);
  });
});

describe('sharpeRatio + walkForwardVerdict helpers', () => {
  it('returns 0 for degenerate series', () => {
    expect(sharpeRatio([])).toBe(0);
    expect(sharpeRatio([1])).toBe(0);
    expect(sharpeRatio([1, 1, 1])).toBe(0);
  });

  it('ranks a consistently-profitable series above a noisy one', () => {
    const good = sharpeRatio([0.01, 0.011, 0.009, 0.01, 0.012]);
    const bad = sharpeRatio([0.01, -0.01, 0.02, -0.02, 0.01]);
    expect(good).toBeGreaterThan(bad);
  });

  it('returns ROBUST when OOS preserves most of the in-sample edge', () => {
    expect(walkForwardVerdict(1.0, 0.9).verdict).toBe('ROBUST');
    expect(walkForwardVerdict(1.0, 0.3).verdict).toBe('WEAK');
    expect(walkForwardVerdict(1.0, 0.0).verdict).toBe('OVERFITTED');
  });
});
