import { describe, it, expect } from 'vitest';
import { SellabilitySimulator, VolumeSpikeDetector } from '../src/services/sellability/sellability-simulator.js';

const NOW = 100_000;

function simulator(simulate: () => { simulated: boolean; sellable: boolean }): SellabilitySimulator {
  return new SellabilitySimulator(simulate, { now: () => NOW });
}

describe('SellabilitySimulator (Kernel D / NERVE A11)', () => {
  const sellableSim = simulator(() => ({ simulated: true, sellable: true }));

  it('returns sellable with a 0-100 score when the round-trip sim passes', async () => {
    const res = await sellableSim.check({
      liquidityUsd: 1000,
      expectedSlippagePct: 1,
      maxSlippagePct: 5,
      pinnedAt: NOW - 1000,
    });
    expect(res.sellable).toBe(true);
    expect(res.score).toBeGreaterThanOrEqual(0);
    expect(res.score).toBeLessThanOrEqual(100);
    expect(res.reasons.join(' ')).toContain('round-trip sell simulated OK');
  });

  it('scores higher with deeper liquidity, holding the round-trip sellable', async () => {
    const shallow = await sellableSim.check({
      liquidityUsd: 100,
      expectedSlippagePct: 0,
      maxSlippagePct: 5,
      pinnedAt: NOW - 1000,
    });
    const deep = await sellableSim.check({
      liquidityUsd: 10_000,
      expectedSlippagePct: 0,
      maxSlippagePct: 5,
      pinnedAt: NOW - 1000,
    });
    expect(deep.score).toBeGreaterThan(shallow.score);
    expect(shallow.score).toBeGreaterThanOrEqual(0);
  });

  it('fails closed to score 0 when the round-trip sell is blocked', async () => {
    const blocked = simulator(() => ({ simulated: true, sellable: false }));
    const res = await blocked.check({ liquidityUsd: 1000, expectedSlippagePct: 1, pinnedAt: NOW - 1000 });
    expect(res.sellable).toBe(false);
    expect(res.score).toBe(0);
    expect(res.reasons.join(' ')).toContain('round-trip sell blocked');
  });

  it('fails closed to score 0 when the simulation itself did not run', async () => {
    const notRun = simulator(() => ({ simulated: false, sellable: false }));
    const res = await notRun.check({ liquidityUsd: 1000, pinnedAt: NOW - 1000 });
    expect(res.sellable).toBe(false);
    expect(res.score).toBe(0);
  });

  it('fails closed to score 0 on a stale pinned block', async () => {
    const res = await sellableSim.check({ liquidityUsd: 1000, blockAgeMs: 200_000 });
    expect(res.sellable).toBe(false);
    expect(res.score).toBe(0);
    expect(res.reasons.join(' ')).toContain('stale');
  });

  it('fails closed to score 0 when the block is unpinned (no age or pin)', async () => {
    const res = await sellableSim.check({ liquidityUsd: 1000 });
    expect(res.sellable).toBe(false);
    expect(res.score).toBe(0);
  });

  it('derives staleness from a stale pinnedAt against the simulator clock', async () => {
    const res = await sellableSim.check({ liquidityUsd: 1000, pinnedAt: NOW - 500_000 });
    expect(res.sellable).toBe(false);
    expect(res.score).toBe(0);
  });

  it('fails closed to score 0 when liquidity is missing or non-positive', async () => {
    const missing = await sellableSim.check({ pinnedAt: NOW - 1000 });
    expect(missing.sellable).toBe(false);
    expect(missing.score).toBe(0);

    const zero = await sellableSim.check({ liquidityUsd: 0, pinnedAt: NOW - 1000 });
    expect(zero.sellable).toBe(false);
    expect(zero.score).toBe(0);
  });

  it('fails closed to score 0 when expected slippage exceeds the limit', async () => {
    const res = await sellableSim.check({
      liquidityUsd: 1000,
      expectedSlippagePct: 20,
      maxSlippagePct: 5,
      pinnedAt: NOW - 1000,
    });
    expect(res.sellable).toBe(false);
    expect(res.score).toBe(0);
  });
});

describe('VolumeSpikeDetector (Kernel D / robinhood-lp-bot Adapt)', () => {
  const bars = (volumes: number[]): { time: number; volumeUsd: number }[] =>
    volumes.map((volumeUsd, i) => ({ time: 1_700_000_000 + i * 60, volumeUsd }));

  it('does not spike on a flat series (ratio ~1)', () => {
    const detector = new VolumeSpikeDetector();
    const res = detector.detect(bars([10, 10, 10, 10]));
    expect(res.spiked).toBe(false);
    expect(res.ratio).toBeCloseTo(1, 5);
  });

  it('spikes when the latest bar clears the 3x baseline', () => {
    const detector = new VolumeSpikeDetector();
    const res = detector.detect(bars([10, 10, 10, 90]));
    expect(res.spiked).toBe(true);
    expect(res.ratio).toBeCloseTo(9, 5);
  });

  it('uses a configurable threshold', () => {
    const detector = new VolumeSpikeDetector({ threshold: 5 });
    const res = detector.detect(bars([10, 10, 10, 30]));
    expect(res.spiked).toBe(false);
    expect(res.ratio).toBeCloseTo(3, 5);
  });

  it('never flags when the trailing baseline is zero (divide-by-zero guard)', () => {
    const detector = new VolumeSpikeDetector();
    const res = detector.detect(bars([0, 0, 100]));
    expect(res.spiked).toBe(false);
    expect(res.ratio).toBe(0);
  });

  it('needs a prior baseline; a single bar is not a spike', () => {
    const detector = new VolumeSpikeDetector();
    const res = detector.detect(bars([100]));
    expect(res.spiked).toBe(false);
    expect(res.ratio).toBe(0);
  });
});
