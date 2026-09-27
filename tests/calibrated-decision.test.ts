import { describe, it, expect } from 'vitest';
import { calibratedDecision, type CalibratedDecision } from '../src/features/calibrated-decision.js';

describe('calibratedDecision (#5 raw_score vs calibrated_probability)', () => {
  it('keeps raw_score and calibrated_probability as DISTINCT numbers', () => {
    const d = calibratedDecision({ rawScore: 88, probability: 0.62, horizon: '1h' });
    expect(d.rawScore).toBe(88);        // the additive heuristic
    expect(d.calibratedProbability).toBe(0.62); // the calibrated P(win)
    // They are never conflated: 88% heuristic != 62% probability.
    expect(d.calibratedProbability).not.toBe(d.rawScore / 100);
  });

  it('clamps to valid ranges and is safe on missing probability', () => {
    const d = calibratedDecision({ rawScore: 105, probability: 1.2 });
    expect(d.rawScore).toBe(100);            // clamped 0-100
    expect(d.calibratedProbability).toBe(1); // clamped 0-1
    const missing = calibratedDecision({ rawScore: 80 });
    expect(missing.calibratedProbability).toBeNull(); // no fabricated probability
  });

  it('carries horizon + provenance for the decision record', () => {
    const d = calibratedDecision({ rawScore: 75, probability: 0.5, horizon: '15m', model: 'arch3-platt' });
    expect(d.horizon).toBe('15m');
    expect(d.model).toBe('arch3-platt');
  });
});