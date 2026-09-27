import { describe, it, expect } from 'vitest';
import { capSignalConfidence } from '../src/orchestrator/swarm-guards.js';

describe('capSignalConfidence evidence-group cap (#2)', () => {
  it('subtracts the smart-money additive overlap once a redundancy threshold is crossed', () => {
    // Same underlying smart-money flow is being counted 4× (detect + signal-boost
    // + track-cluster + strategy). The cap strips the redundant stacking.
    const base = capSignalConfidence(95, 1); // 1 SM source, no redundancy
    const inflated = capSignalConfidence(95, 4); // 4 readouts of the SAME flow
    expect(base).toBeGreaterThan(inflated);
  });

  it('leaves a single clean signal untouched', () => {
    expect(capSignalConfidence(80, 1)).toBe(80);
    expect(capSignalConfidence(60, 1)).toBe(60);
  });

  it('binds the reduction to a ceiling — never collapses the signal to a floor', () => {
    const reduced = capSignalConfidence(95, 4);
    expect(reduced).toBeGreaterThanOrEqual(70); // still a strong signal, just debiased
    expect(reduced).toBeLessThanOrEqual(100);
  });

  it('returns NaN-proof: undefined redundancy defaults to no cap', () => {
    expect(capSignalConfidence(90, undefined)).toBe(90);
  });
});