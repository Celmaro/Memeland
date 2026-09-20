import { describe, expect, it } from 'vitest';
import {
  tpLadderExit,
  refinedStopLoss,
  DEFAULT_TP_LADDER,
} from '../src/position/position-manager.js';

describe('tpLadderExit (SRC-209 vegapunk graceful TP)', () => {
  it('triggers no scale-out below the first target', () => {
    const r = tpLadderExit(1, 1.5, DEFAULT_TP_LADDER);
    expect(r.triggered).toEqual([]);
    expect(r.totalScaleOutFraction).toBe(0);
    expect(r.remainingFraction).toBe(1);
  });

  it('scales out by the triggered steps above each target', () => {
    const r = tpLadderExit(1, 3.5, DEFAULT_TP_LADDER);
    expect(r.triggered.length).toBe(2);
    expect(r.totalScaleOutFraction).toBe(1);
    expect(r.remainingFraction).toBe(0);
  });

  it('is fail-closed on invalid input', () => {
    expect(tpLadderExit(0, 2).triggered).toEqual([]);
    expect(tpLadderExit(1, 0.5).triggered).toEqual([]);
    expect(tpLadderExit(1, 2, [{ targetMultiplier: 0.5, scaleOutFraction: 2 }]).triggered).toEqual([]);
  });

  it('sorts steps by target regardless of input order', () => {
    const r = tpLadderExit(1, 3, [
      { targetMultiplier: 3, scaleOutFraction: 0.4 },
      { targetMultiplier: 2, scaleOutFraction: 0.6 },
    ]);
    expect(r.triggered[0].targetMultiplier).toBe(2);
    expect(r.triggered[1].targetMultiplier).toBe(3);
  });
});

describe('refinedStopLoss (SRC-209 graceful exit side)', () => {
  it('never loosens below the protective floor', () => {
    // Loose trail (90%) would sit below the 50% floor; the floor must bind.
    const r = refinedStopLoss(1, 1.01, 0.5, 0.9);
    expect(r).not.toBeNull();
    expect((r as { stopPriceUsd: number }).stopPriceUsd).toBeCloseTo(0.5, 5);
    expect((r as { reason: string }).reason).toBe('entry protection floor');
  });

  it('tightens as the high-water mark rises', () => {
    const r = refinedStopLoss(1, 2.5, 0.5, 0.35);
    expect(r).not.toBeNull();
    const stop = r as { stopPriceUsd: number; reason: string };
    expect(stop.stopPriceUsd).toBeCloseTo(2.5 * 0.65, 5);
    expect(stop.reason).toBe('high-water trail');
  });

  it('is fail-closed on invalid input', () => {
    expect(refinedStopLoss(0, 1)).toBeNull();
    expect(refinedStopLoss(1, 0.5)).toBeNull();
    expect(refinedStopLoss(1, 2, 1.5, 0.5)).toBeNull();
    expect(refinedStopLoss(1, 2, 0.5, -0.1)).toBeNull();
  });
});
