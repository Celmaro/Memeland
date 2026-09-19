import { describe, it, expect } from 'vitest';
import {
  deflationFactor,
  deflatedSharpe,
  purgedCV,
  leakageDetector,
  latchedKillSwitch,
  tca,
} from '../src/orchestrator/learning-harness.js';

describe('learning-harness deflatedSharpe', () => {
  it('penalizes a low trial count vs. a naive Sharpe', () => {
    const oneTrial = deflatedSharpe(3, 1);
    const hundredTrials = deflatedSharpe(3, 100);
    expect(oneTrial).toBeLessThan(hundredTrials);
    expect(oneTrial).toBeLessThan(3);
    expect(hundredTrials).toBeCloseTo(3, 0);
  });

  it('deflation factor shrinks with more trials and is bounded', () => {
    expect(deflationFactor(1)).toBeLessThan(deflationFactor(10));
    expect(deflationFactor(10)).toBeLessThan(deflationFactor(1000));
    expect(deflationFactor(1)).toBeGreaterThanOrEqual(0);
    expect(deflationFactor(1000)).toBeLessThanOrEqual(1);
  });

  it('clamps absurd Sharpe values and NaN to sane ranges', () => {
    expect(deflatedSharpe(1e9, 1)).toBeLessThanOrEqual(10);
    expect(deflatedSharpe(Number.NaN, 5)).toBe(0);
  });
});

describe('learning-harness purgedCV', () => {
  it('drops samples within the embargo gap of the test fold', () => {
    const returns = [0, 0, 0, 0, 0, 9, 9, 9, 9, 9];
    // 10 points, 2 splits, embargo 0: each fold trains on the other 5 points.
    const noEmbargo = purgedCV(returns, 2, 0, (train) => train.length);
    expect(noEmbargo.folds).toEqual([5, 5]);
    // Embargo 1 removes the single point adjacent to each test fold boundary.
    const embargoed = purgedCV(returns, 2, 1, (train) => train.length);
    expect(embargoed.folds).toEqual([4, 4]);
  });

  it('returns NaN-safe empty folds on degenerate input', () => {
    const { mean, folds } = purgedCV([1, 2], 10, 0);
    expect(folds).toEqual([]);
    expect(mean).toBeNaN();
  });
});

describe('learning-harness leakageDetector', () => {
  it('flags a feature that embeds the target', () => {
    const target = [1, 1, 1, 0, 0, 0];
    const features = target.map((t) => [t * 100]); // perfectly collinear
    const result = leakageDetector(features, target);
    expect(result.leaked).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0.8);
  });

  it('flags a zero-variance feature', () => {
    const target = [1, 1, 0, 0];
    const features = [[5], [5], [5], [5]];
    const result = leakageDetector(features, target);
    expect(result.leaked).toBe(true);
    expect(result.score).toBe(1);
  });

  it('treats mismatched input as leaked (fail-closed)', () => {
    const result = leakageDetector([], [1, 2, 3]);
    expect(result.leaked).toBe(true);
  });
});

describe('learning-harness latchedKillSwitch', () => {
  it('stays engaged across a simulated restart over a shared store', () => {
    const store = { engaged: false };
    const cfg = () => ({
      persistLoad: () => store.engaged,
      persistSave: (v: boolean) => {
        store.engaged = v;
      },
    });
    const k1 = latchedKillSwitch(cfg());
    k1.trip('boom');
    expect(store.engaged).toBe(true);
    expect(k1.reason()).toBe('boom');
    const k2 = latchedKillSwitch(cfg());
    expect(k2.isEngaged()).toBe(true);
  });

  it('reset clears and persists false', () => {
    const store = { engaged: false };
    const cfg = () => ({
      persistLoad: () => store.engaged,
      persistSave: (v: boolean) => {
        store.engaged = v;
      },
    });
    const k1 = latchedKillSwitch(cfg());
    k1.trip('x');
    const k2 = latchedKillSwitch(cfg());
    k2.reset();
    expect(store.engaged).toBe(false);
    expect(k2.isEngaged()).toBe(false);
  });

  it('default path without persistence is not latched', () => {
    const k1 = latchedKillSwitch();
    k1.trip('not persisted');
    expect(latchedKillSwitch().isEngaged()).toBe(false);
  });
});

describe('learning-harness tca', () => {
  it('reports adverse basis for a buy filled above the mid', () => {
    const { basisBps } = tca(101, 100, 'buy');
    expect(basisBps).toBeCloseTo(100, 0); // (101-100)/100 * 10000 = 100
  });

  it('reports favorable basis for a sell filled above the mid', () => {
    const { basisBps } = tca(101, 100, 'sell');
    expect(basisBps).toBeCloseTo(-100, 0);
  });

  it('scales shortfall by quantity', () => {
    const q1 = tca(102, 100, 'buy', 1);
    const q3 = tca(102, 100, 'buy', 3);
    expect(q3.implementationShortfallBps).toBeCloseTo(q1.implementationShortfallBps * 3, 0);
  });
});
