import { describe, it, expect } from 'vitest';
import { CalibrationModel } from '../src/features/calibration.js';

describe('CalibrationModel (P14 — calibrated P(win) from durable labeled outcomes)', () => {
  it('returns null below the total-sample floor (never fabricates a probability)', () => {
    const m = new CalibrationModel({ minTotalSamples: 30 });
    for (let i = 0; i < 5; i++) m.ingest(50, true);
    expect(m.sampleCount()).toBe(5);
    expect(m.probability(50)).toBeNull();
  });

  it('emits a higher P(win) for high-scoring buckets than low-scoring ones', () => {
    // 100 labels: highs mostly win, lows mostly lose.
    const m = new CalibrationModel({ minTotalSamples: 10, minSamplesPerBin: 3 });
    for (let i = 0; i < 50; i++) m.ingest(90, true); // high → wins
    for (let i = 0; i < 50; i++) m.ingest(10, false); // low → losses
    const high = m.probability(90)!;
    const low = m.probability(10)!;
    expect(high).toBeGreaterThan(0.5);
    expect(low).toBeLessThan(0.5);
    expect(high).toBeGreaterThan(low);
    expect(high).toBeLessThan(1); // Laplace keeps it strictly in (0,1)
    expect(low).toBeGreaterThan(0);
  });

  it('returns null for a bucket with too few samples even when total floor is met', () => {
    const m = new CalibrationModel({ minTotalSamples: 5, minSamplesPerBin: 5 });
    m.ingest(20, false);
    m.ingest(20, false);
    m.ingest(20, false);
    m.ingest(20, true);
    m.ingest(20, true); // bucket has 5
    m.ingest(80, true); // total 6 ≥ 5, but bucket 80 has only 1
    expect(m.probability(20)).not.toBeNull();
    expect(m.probability(80)).toBeNull();
  });

  it('seedFromPaperTrades derives labels from realizedPnlPct > 0', () => {
    const m = new CalibrationModel({ minTotalSamples: 3, minSamplesPerBin: 1 });
    m.seedFromPaperTrades([
      { confidence: 70, realizedPnlPct: 12 },   // win
      { confidence: 70, realizedPnlPct: -5 },   // loss
      { confidence: 70, realizedPnlPct: 3 },    // win
    ]);
    expect(m.sampleCount()).toBe(3);
    expect(m.probability(70)).toBeCloseTo((2 + 1) / (3 + 2)); // 0.6
  });

  it('hydrate rebuilds the model and refuses to clobber a live one', () => {
    const m = new CalibrationModel({ minTotalSamples: 1, minSamplesPerBin: 1 });
    m.hydrate([{ rawScore: 55, won: true }, { rawScore: 55, won: false }, { rawScore: 55, won: true }]);
    expect(m.sampleCount()).toBe(3);
    expect(m.probability(55)).toBeCloseTo((2 + 1) / (3 + 2));
    // live ingestion then hydrate is a no-op
    m.ingest(90, true);
    const before = m.sampleCount();
    m.hydrate([{ rawScore: 10, won: false }]);
    expect(m.sampleCount()).toBe(before); // not clobbered
  });
});