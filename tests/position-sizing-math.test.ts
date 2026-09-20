import { describe, it, expect } from 'vitest';
import {
  fractionalKelly,
  fractionalKellySize,
  dailyLossCapSize,
  maxPositionCapSize,
  confidenceScaledSize,
  atrStopLoss,
  atrTakeProfit,
  trailingStopPrice,
} from '../src/orchestrator/position-sizing.js';

describe('fractional Kelly sizing', () => {
  it('returns a fraction of the full Kelly edge, clamped to [0, 1]', () => {
    expect(fractionalKelly(0.6, 1, 0.25)).toBeCloseTo(0.05);
    expect(fractionalKelly(0.7, 2, 0.5)).toBeCloseTo(0.275);
    expect(fractionalKelly(0.5, 1, 0.25)).toBe(0);
    expect(fractionalKelly(0.2, 1, 1)).toBe(0);
  });

  it('rejects invalid inputs without inventing risk', () => {
    expect(fractionalKelly(-0.1, 1, 0.25)).toBe(0);
    expect(fractionalKelly(0.6, -1, 0.25)).toBe(0);
    expect(fractionalKelly(0.6, 1, 1.5)).toBe(0);
  });

  it('converts the fractional Kelly fraction into a USD size', () => {
    expect(fractionalKellySize(10_000, 0.6, 1, 0.25)).toBe(500);
    expect(fractionalKellySize(10_000, 0.7, 2, 0.5)).toBeCloseTo(2750);
  });
});

describe('daily-loss and max-position caps', () => {
  it('caps desired size to remaining daily-loss headroom', () => {
    expect(dailyLossCapSize(500, 1000, 800)).toBe(200);
    expect(dailyLossCapSize(100, 1000, 800)).toBe(100);
  });

  it('halts sizing when daily loss is already at or over the limit', () => {
    expect(dailyLossCapSize(500, 1000, 1000)).toBe(0);
    expect(dailyLossCapSize(500, 0, 0)).toBe(0);
  });

  it('caps desired size to the hard max-position wall', () => {
    expect(maxPositionCapSize(5000, 2000)).toBe(2000);
    expect(maxPositionCapSize(1000, 2000)).toBe(1000);
    expect(maxPositionCapSize(1000, 0)).toBe(0);
  });
});

describe('confidence-scaled sizing', () => {
  it('maps 0-100 confidence linearly into the configured min/max scale', () => {
    expect(confidenceScaledSize(1000, 0, 0.5, 1.5)).toBe(500);
    expect(confidenceScaledSize(1000, 80, 0.5, 1.5)).toBe(1300);
    expect(confidenceScaledSize(1000, 100, 0.5, 1.5)).toBe(1500);
  });

  it('treats fractional confidence as a 0-1 input when provided that way', () => {
    expect(confidenceScaledSize(1000, 0.8, 0.5, 1.5)).toBe(1300);
  });
});

describe('ATR stop-loss / take-profit', () => {
  it('brackets entry with ATR-based risk levels', () => {
    expect(atrStopLoss(100, 5, 2)).toBeCloseTo(90);
    expect(atrTakeProfit(100, 5, 3)).toBeCloseTo(115);
    expect(atrTakeProfit(100, 5, 2)).toBeCloseTo(110);
  });

  it('does not move the stop when ATR is zero', () => {
    expect(atrStopLoss(100, 0, 2)).toBeCloseTo(100);
    expect(atrTakeProfit(100, 0, 3)).toBeCloseTo(100);
  });
});

describe('activation-threshold trailing stop', () => {
  it('returns a trailed stop only after the activation profit threshold', () => {
    expect(trailingStopPrice(100, 180, 15, 50)).toBeCloseTo(153);
    expect(trailingStopPrice(100, 140, 15, 50)).toBeNull();
    expect(trailingStopPrice(100, 100, 15, 50)).toBeNull();
    expect(trailingStopPrice(100, 90, 15, 50)).toBeNull();
  });
});
