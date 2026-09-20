import { describe, it, expect } from 'vitest';
import {
  regimeAwareFloor,
  resolveConflict,
  calibratedConfidence,
  cohortVote,
  type Regime,
} from '../src/orchestrator/swarm-guards.js';

describe('regimeAwareFloor (Kernel B — prism-insight Adapt)', () => {
  it('floors a bear market at 0.90 and every other regime at 0.80', () => {
    expect(regimeAwareFloor('TRENDING_BEAR')).toBe(0.9);
    for (const r of ['TRENDING_BULL', 'CHOP', 'EXTREME_VOLATILITY'] as Regime[]) {
      expect(regimeAwareFloor(r)).toBe(0.8);
    }
  });
});

describe('resolveConflict (Kernel B — Decision Hub A5 asymmetric conflict)', () => {
  it('a single BUY facing >= 2x SELL weight is vetoed (1BUY + 2SELL = 0.0)', () => {
    const r = resolveConflict([
      { side: 'BUY', weight: 1 },
      { side: 'SELL', weight: 1 },
      { side: 'SELL', weight: 1 },
    ]);
    expect(r.conflicted).toBe(true);
    expect(r.resume).toBe(false);
    expect(r.reason).toMatch(/asymmetric/i);
  });

  it('a conflict below the 2:1 veto threshold resumes rather than blocks', () => {
    const r = resolveConflict([
      { side: 'BUY', weight: 1 },
      { side: 'SELL', weight: 0.5 },
    ]);
    expect(r.conflicted).toBe(true);
    expect(r.resume).toBe(true);
  });

  it('a single-direction set is not conflicted', () => {
    const r = resolveConflict([{ side: 'BUY', weight: 2 }]);
    expect(r.conflicted).toBe(false);
    expect(r.resume).toBe(true);
  });
});

describe('calibratedConfidence (Kernel B — zetryn A27 downgrade-only)', () => {
  it('never exceeds the raw score (downgrade-only) and falls back to raw without a map', () => {
    expect(calibratedConfidence(80, null)).toBe(80);
    expect(calibratedConfidence(80, { 80: 70 })).toBe(70);
    // must not boost above the raw score even if the map says higher
    expect(calibratedConfidence(80, { 80: 95 })).toBe(80);
  });
});

describe('cohortVote (Kernel B — FlySwarm A21 Jaccard)', () => {
  it('scores the Jaccard overlap of observed vs cohort addresses 0-100', () => {
    const r = cohortVote(['a', 'b'], ['b', 'c']);
    // overlap {b} / union {a,b,c} = 1/3
    expect(r.crimeNoise).toBeCloseTo(1 / 3);
    expect(r.score).toBe(Math.round((1 / 3) * 100));
    expect(cohortVote(['x'], ['y']).score).toBe(0);
  });
});
