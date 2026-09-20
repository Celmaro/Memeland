import { describe, it, expect } from 'vitest';
import {
  peakCaptureRatio,
  grossNetSplit,
  maxDrawdownPct,
  walkForwardVerdict,
  computeBacktestMetrics,
} from '../src/orchestrator/learning-harness.js';

describe('peakCaptureRatio', () => {
  it('returns the ratio of exit PnL to peak PnL for a winning trade', () => {
    const ratio = peakCaptureRatio([
      { entryPrice: 100, exitPrice: 180, peakPrice: 200, qty: 1 },
    ]);
    expect(ratio).toBeCloseTo(0.8, 6); // (180-100)/(200-100)
  });

  it('returns null when no trade has a peak above entry', () => {
    const ratio = peakCaptureRatio([
      { entryPrice: 100, exitPrice: 90, peakPrice: 95, qty: 1 },
    ]);
    expect(ratio).toBeNull();
  });
});

describe('grossNetSplit', () => {
  it('splits gross vs net PnL subtracting fees and slippage', () => {
    const split = grossNetSplit([
      {
        entryPrice: 100,
        exitPrice: 110,
        qty: 10,
        feesUsd: 5,
        slippageUsd: 2,
      },
    ]);
    expect(split.grossPnlUsd).toBeCloseTo(100, 6);
    expect(split.netPnlUsd).toBeCloseTo(93, 6);
    expect(split.ratioPct).toBeCloseTo(93, 6);
  });
});

describe('maxDrawdownPct', () => {
  it('computes the largest peak-to-trough drawdown', () => {
    const dd = maxDrawdownPct([1000, 1100, 1050, 1200, 1100]);
    // peak 1100 -> 1050 = 4.5454%, then 1200 -> 1100 = 8.33%
    expect(dd).toBeCloseTo(8.3333, 3);
  });

  it('returns 0 for a monotonic curve', () => {
    expect(maxDrawdownPct([1000, 1100, 1200])).toBe(0);
  });
});

describe('walkForwardVerdict (PR8.a)', () => {
  it('declares ROBUST when out-of-sample Sharpe holds >= 0.8 of in-sample', () => {
    expect(walkForwardVerdict(1, 0.9).verdict).toBe('ROBUST');
  });

  it('declares WEAK for a moderate dropoff', () => {
    expect(walkForwardVerdict(1, 0.4).verdict).toBe('WEAK');
  });

  it('declares OVERFITTED for a severe dropoff', () => {
    expect(walkForwardVerdict(1, 0.1).verdict).toBe('OVERFITTED');
  });

  it('fail-closed: non-positive in-sample Sharpe is OVERFITTED', () => {
    expect(walkForwardVerdict(-0.2, 0.5).verdict).toBe('OVERFITTED');
  });
});

describe('computeBacktestMetrics', () => {
  it('assembles per-candidate metrics', () => {
    const m = computeBacktestMetrics({
      candidateId: 'momentum-v2',
      trades: [
        {
          entryPrice: 100,
          exitPrice: 180,
          peakPrice: 200,
          qty: 1,
          feesUsd: 2,
          slippageUsd: 1,
        },
        {
          entryPrice: 100,
          exitPrice: 90,
          qty: 1,
          feesUsd: 2,
          slippageUsd: 1,
        },
      ],
      equityCurve: [1000, 1100, 1050, 1200],
      inSampleSharpe: 1.2,
      outOfSampleSharpe: 1.1,
    });
    expect(m.candidateId).toBe('momentum-v2');
    expect(m.grossPnlUsd).toBeCloseTo(70, 6); // 80 + (-10)
    expect(m.netPnlUsd).toBeCloseTo((80 - 3) + (-10 - 3), 6); // 64
    expect(m.peakCaptureRatio).toBeCloseTo(0.8, 6);
    expect(m.overfitVerdict).toBe('ROBUST');
    expect(m.maxDrawdownPct).toBeGreaterThan(0);
  });
});
