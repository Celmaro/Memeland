import { describe, it, expect } from 'vitest';
import { flowConvergenceScore } from '../src/services/flow-convergence.js';

const now = 1_000_000_000;
const min = 60_000;

function buy(wallet: string, amountUsd: number, ageMs: number) {
  return { wallet, amountUsd, timestamp: now - ageMs };
}

describe('flowConvergenceScore (Q05)', () => {
  it('N distributed buys within the window raise the convergence score', () => {
    const r = flowConvergenceScore(
      [1, 2, 3, 4, 5].map((n) => buy(`w${n}`, 20_000 / n, 30_000)),
      { windowMs: 15 * min },
      now
    );
    expect(r.converged).toBe(true);
    expect(r.distinctWallets).toBe(5);
    expect(r.score).toBeGreaterThan(50);
  });

  it('a single high-balance whale does not count as convergence', () => {
    const r = flowConvergenceScore(
      [buy('whale', 1_000_000, 30_000)],
      { windowMs: 15 * min, minWallets: 3, maxWalletShare: 0.5 },
      now
    );
    expect(r.converged).toBe(false);
    expect(r.score).toBe(50);
  });

  it('a dominant single wallet keeps the score neutral even with many wallets', () => {
    const r = flowConvergenceScore(
      [buy('whale', 900_000, 30_000), buy('a', 100, 30_000), buy('b', 100, 30_000), buy('c', 100, 30_000)],
      { windowMs: 15 * min, maxWalletShare: 0.5 },
      now
    );
    expect(r.converged).toBe(false);
    expect(r.score).toBe(50);
  });

  it('stale windows (outside windowMs) score neutral — never a false positive', () => {
    const r = flowConvergenceScore(
      [1, 2, 3, 4, 5].map((n) => buy(`w${n}`, 5000, 60 * min)),
      { windowMs: 15 * min },
      now
    );
    expect(r.converged).toBe(false);
    expect(r.score).toBe(50);
  });

  it('empty input scores neutral', () => {
    const r = flowConvergenceScore([], {}, now);
    expect(r.score).toBe(50);
    expect(r.converged).toBe(false);
  });
});
