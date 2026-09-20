import { describe, expect, it } from 'vitest';
import { twoCandleAboveEntry, type Candle } from '../src/position/position-manager.js';

function candle(close: number, overrides: Partial<Candle> = {}): Candle {
  return { open: close, high: close, low: close, close, ...overrides };
}

describe('twoCandleAboveEntry (SRC-219 uerax confirmation rule)', () => {
  it('confirms when the last two candles close above entry', () => {
    const r = twoCandleAboveEntry([candle(0.9), candle(1.1), candle(1.2)], 1.0);
    expect(r.confirmed).toBe(true);
    expect(r.consecutiveAbove).toBe(2);
  });

  it('does not confirm with only one candle above entry', () => {
    const r = twoCandleAboveEntry([candle(0.8), candle(1.1)], 1.0);
    expect(r.confirmed).toBe(false);
    expect(r.consecutiveAbove).toBe(1);
  });

  it('is fail-closed on empty or invalid input', () => {
    expect(twoCandleAboveEntry([], 1.0).confirmed).toBe(false);
    expect(twoCandleAboveEntry([candle(1.2)], 0).confirmed).toBe(false);
    expect(twoCandleAboveEntry([candle(Number.NaN), candle(1.2)], 1.0).confirmed).toBe(false);
  });

  it('breaks the run on a candle closing below entry', () => {
    const r = twoCandleAboveEntry([candle(1.2), candle(1.15), candle(0.9), candle(1.3)], 1.0);
    expect(r.consecutiveAbove).toBe(1);
    expect(r.confirmed).toBe(false);
  });
});
