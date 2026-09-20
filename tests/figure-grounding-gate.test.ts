import { describe, expect, it } from 'vitest';
import { figureGroundingGate } from '../src/services/figure-grounding-gate.js';

describe('figureGroundingGate (SRC-109 Vibe-Trading figure-grounding)', () => {
  const now = 1_000_000_000_000;

  it('accepts a figure grounded in recent prior prints', () => {
    const r = figureGroundingGate(
      [
        { at: now - 60_000, value: 100 },
        { at: now - 30_000, value: 105 },
      ],
      now,
    );
    expect(r.grounded).toBe(true);
    expect(r.supportingPrints).toBe(2);
  });

  it('rejects a figure with no in-window prints (stale / missing)', () => {
    const r = figureGroundingGate([{ at: now - 10_000_000, value: 100 }], now);
    expect(r.grounded).toBe(false);
    expect(r.supportingPrints).toBe(0);
  });

  it('never accepts a future print (no look-ahead)', () => {
    const r = figureGroundingGate([{ at: now + 60_000, value: 100 }], now);
    expect(r.grounded).toBe(false);
  });

  it('honors a higher minPrints floor', () => {
    const r = figureGroundingGate([{ at: now - 10_000, value: 100 }], now, { minPrints: 2 });
    expect(r.grounded).toBe(false);
  });

  it('fails closed on empty or invalid input', () => {
    expect(figureGroundingGate([], now).grounded).toBe(false);
    expect(figureGroundingGate([{ at: now, value: Number.NaN }], now).grounded).toBe(false);
  });
});
