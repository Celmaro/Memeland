import { describe, it, expect } from 'vitest';
import {
  voterICs,
  icWeightDeltas,
  applyDeltas,
  plattCalibrate,
  walkForwardSplit,
  type CalibrationRow,
} from '../src/orchestrator/scoring-calibration.js';

const VOTERS = ['quant', 'ml', 'noise'];

function flatRows(): CalibrationRow[] {
  // quant correlates with the labels; ml partial; noise constant (r=0).
  const label = (s: number) => (s > 50 ? 1 : 0);
  const rows: CalibrationRow[] = [];
  for (const s of [10, 20, 30, 70, 80, 90, 95, 60]) {
    rows.push({
      voterScores: { quant: s, ml: 100 - s, noise: 50 },
      realized: label(s),
      timestamp: s * 1000,
    });
  }
  return rows;
}

describe('IC weighting (Q10)', () => {
  it('higher-IC voters get proportionally larger weight deltas', () => {
    const rows = flatRows();
    const ics = voterICs(rows, VOTERS);
    expect(ics.quant).toBeGreaterThan(0.9); // near-perfect correlation
    expect(ics.noise).toBeLessThan(0.01); // constant => r=0
    const { deltas } = icWeightDeltas(rows, VOTERS, { quant: 0.2, ml: 0.15, noise: 0.1 });
    expect(deltas.quant).toBeGreaterThan(deltas.ml);
    expect(deltas.quant).toBeGreaterThan(0);
    expect(Math.abs(deltas.noise)).toBeLessThan(1e-9);
    // Deltas stay bounded after application.
    const updated = applyDeltas({ quant: 0.2, ml: 0.15, noise: 0.1 }, deltas);
    for (const v of VOTERS) {
      expect(updated[v]).toBeGreaterThanOrEqual(0.02);
      expect(updated[v]).toBeLessThanOrEqual(0.5);
    }
  });
});

describe('Platt calibration (Q10)', () => {
  it('confidence stays in [0,1] and is rank-preserving', () => {
    for (const s of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1]) {
      const p = plattCalibrate(s, 2, -1);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
    expect(plattCalibrate(0.2, 2, -1)).toBeLessThan(plattCalibrate(0.8, 2, -1));
    // Out-of-range and NaN degrade safely.
    const nan = plattCalibrate(NaN, 2, -1);
    expect(nan).toBeGreaterThanOrEqual(0);
    expect(nan).toBeLessThanOrEqual(1);
  });
});

describe('walk-forward split (Q10)', () => {
  it('keeps the validation fold leak-free (train earlier in time)', () => {
    const rows = flatRows();
    const { train, validation } = walkForwardSplit(rows, 4);
    expect(validation.length).toBeGreaterThan(0);
    const lastTrain = Math.max(...train.map((r) => r.timestamp ?? 0));
    const firstVal = Math.min(...validation.map((r) => r.timestamp ?? 0));
    expect(lastTrain).toBeLessThan(firstVal);
    // No overlap between folds.
    const trainIds = new Set(train.map((r) => r.timestamp));
    expect(validation.every((r) => !trainIds.has(r.timestamp))).toBe(true);
  });
});
