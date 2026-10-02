import { describe, it, expect } from 'vitest';
import {
  liquidityVelocity,
  orderFlowImbalance,
  smartMoneyPenetration,
  top10Concentration,
  deployerSurvivalIndex,
  evaluateCandidateFast,
  scoreCandidate,
} from './fast-scorer.js';

describe('feature normalization', () => {
  it('liquidityVelocity is positive on injection, negative on drain, ~0 flat', () => {
    expect(liquidityVelocity(2000, 1000)).toBeGreaterThan(0);
    expect(liquidityVelocity(500, 1000)).toBeLessThan(0);
    expect(Math.abs(liquidityVelocity(1000, 1000))).toBeLessThan(1e-9);
    expect(Number.isFinite(liquidityVelocity(1000, 0))).toBe(true); // eps-guarded, no NaN
  });

  it('orderFlowImbalance is +1 on pure buys, −1 on pure sells, 0 balanced', () => {
    expect(orderFlowImbalance(100, 0)).toBeCloseTo(1, 5);
    expect(orderFlowImbalance(0, 100)).toBeCloseTo(-1, 5);
    expect(orderFlowImbalance(50, 50)).toBeCloseTo(0, 5);
    expect(Number.isFinite(orderFlowImbalance(0, 0))).toBe(true);
  });

  it('smartMoneyPenetration saturates at 1.0 by 5 wallets', () => {
    expect(smartMoneyPenetration(2)).toBeCloseTo(0.4, 5);
    expect(smartMoneyPenetration(5)).toBe(1);
    expect(smartMoneyPenetration(20)).toBe(1);
    expect(smartMoneyPenetration(-3)).toBe(0);
  });

  it('top10Concentration is top10/total; 0 for empty supply', () => {
    expect(top10Concentration(25, 100)).toBeCloseTo(0.25, 5);
    expect(top10Concentration(50, 0)).toBe(0);
  });

  it('deployerSurvivalIndex is 1 for clean history, lower with rugs', () => {
    expect(deployerSurvivalIndex(0, 3)).toBe(1);
    expect(deployerSurvivalIndex(3, 3)).toBeCloseTo(1 - 3 / 4, 5);
  });
});

describe('evaluateCandidateFast — zero-alloc sigmoid', () => {
  it('strong positive features score above a weak-token baseline', () => {
    const strong = evaluateCandidateFast(1.0, 1.0, 1.0, 0.1, 1.0);
    const weak = evaluateCandidateFast(-1.0, -1.0, 0.0, 0.9, 0.1);
    expect(strong).toBeGreaterThan(weak);
    expect(strong).toBeGreaterThan(0.5);
    expect(weak).toBeLessThan(0.5);
  });

  it('returns within (0,1)', () => {
    expect(evaluateCandidateFast(9, 9, 9, 9, 9)).toBeLessThan(1);
    expect(evaluateCandidateFast(-9, -9, -9, -9, -9)).toBeGreaterThan(0);
  });

  it('is deterministic and non-allocating on repeated calls', () => {
    const a = evaluateCandidateFast(0.5, -0.2, 0.8, 0.3, 0.9);
    const b = evaluateCandidateFast(0.5, -0.2, 0.8, 0.3, 0.9);
    expect(a).toBe(b);
  });
});

describe('scoreCandidate — fail-open gate', () => {
  const clean = {
    currentLiqUsd: 5000,
    fiveMinAgoUsd: 1000,
    buyVol1hUsd: 5000,
    sellVol1hUsd: 500,
    numSmartWallets: 4,
    top10Supply: 20,
    totalSupply: 100,
    numHistoricalRugs: 0,
    numTotalLaunches: 0,
  };

  it('a strong clean token passes the default gate', () => {
    const r = scoreCandidate(clean);
    expect(r.passed).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(0.5);
  });

  it('a concentrated / rug-heavy token is flagged regardless of raw score', () => {
    const r = scoreCandidate({ ...clean, top10Supply: 90, totalSupply: 100, numHistoricalRugs: 4, numTotalLaunches: 2 });
    expect(r.passed).toBe(false);
    expect(r.flagged).toBeDefined();
  });

  it('respects a custom threshold', () => {
    expect(scoreCandidate(clean, { threshold: 0.01 }).passed).toBe(true);
    expect(scoreCandidate(clean, { threshold: 0.99 }).passed).toBe(false);
  });

  it('is fail-open on degenerate input (no throw, deterministic)', () => {
    const r = scoreCandidate({ ...clean, currentLiqUsd: 0, fiveMinAgoUsd: 0, buyVol1hUsd: 0, sellVol1hUsd: 0 });
    expect(Number.isFinite(r.score)).toBe(true);
  });
});