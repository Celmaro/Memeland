import { describe, it, expect } from 'vitest';
import {
  evaluateDegradation,
  applyRiskDiscount,
  degradationReason,
  FEATURE_TIERS,
} from '../src/enrichment/degradation-tiers.js';

const all = (): Record<string, boolean> => Object.keys(FEATURE_TIERS).reduce((acc, f) => ({ ...acc, [f]: true }), {});

describe('degradation-tiers (6.5 — hard-gate vs soft-feature)', () => {
  it('fails closed only when a HARD feature is missing', () => {
    const gated = evaluateDegradation({ available: { ...all(), security: false } });
    expect(gated.hardGated).toBe(true);
    expect(gated.degradedSoft).toEqual([]);
    expect(gated.riskDiscount).toBe(1);
  });

  it('degrades — never kills — when only SOFT features are missing', () => {
    const avail = all();
    delete avail.sentiment;
    delete avail['arkham-entity'];
    const r = evaluateDegradation({ available: avail });
    expect(r.hardGated).toBe(false);
    expect(r.degradedSoft.sort()).toEqual(['arkham-entity', 'sentiment']);
    expect(r.riskDiscount).toBeLessThan(1);
    expect(r.riskDiscount).toBeGreaterThan(0.5);
  });

  it('no degradation when everything is present', () => {
    const r = evaluateDegradation({ available: all() });
    expect(r.hardGated).toBe(false);
    expect(r.degradedSoft).toEqual([]);
    expect(r.riskDiscount).toBe(1);
    expect(degradationReason(r)).toBe('no degradation');
  });

  it('applyRiskDiscount scales a confidence score and clamps to [0,100]', () => {
    expect(applyRiskDiscount(80, 0.85)).toBeCloseTo(68);
    expect(applyRiskDiscount(120, 0.85)).toBe(100);
    expect(applyRiskDiscount(-10, 0.85)).toBe(0);
  });

  it('hard features are exactly the safety-critical ones', () => {
    const hard = (Object.keys(FEATURE_TIERS) as (keyof typeof FEATURE_TIERS)[])
      .filter((f) => FEATURE_TIERS[f] === 'hard');
    expect(hard.sort()).toEqual(['onchain-existence', 'security', 'sellability']);
  });
});