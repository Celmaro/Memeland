import { describe, it, expect } from 'vitest';
import { confidenceToFraction } from '../src/services/confidence.js';

describe('confidenceToFraction', () => {
  it('maps 0-100 percent to a 0-1 fraction', () => {
    expect(confidenceToFraction(0)).toBe(0);
    expect(confidenceToFraction(80)).toBe(0.8);
    expect(confidenceToFraction(100)).toBe(1);
  });

  it('passes 0-1 fractions through unchanged', () => {
    expect(confidenceToFraction(0.8)).toBe(0.8);
    expect(confidenceToFraction(1)).toBe(1);
    expect(confidenceToFraction(0)).toBe(0);
  });

  it('clamps out-of-range inputs into [0,1]', () => {
    expect(confidenceToFraction(150)).toBe(1);
    expect(confidenceToFraction(-5)).toBe(0);
    // Values in (1, 100] are interpreted as percent, then divided by 100.
    expect(confidenceToFraction(1.2)).toBe(0.012);
  });

  it('fails closed to 0 for non-finite values', () => {
    expect(confidenceToFraction(Number.NaN)).toBe(0);
    expect(confidenceToFraction(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
