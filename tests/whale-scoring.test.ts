import { describe, it, expect } from 'vitest';
import { walletScore, walletScoreFromTrades } from '../src/services/wallet-scoring.js';
import { whaleVote } from '../src/orchestrator/voters.js';

describe('walletScore (Q03)', () => {
  it('returns a neutral 50 baseline when all fields are absent/NaN (never a false win)', () => {
    const r = walletScore({});
    expect(r.score).toBe(50);
    expect(r.degraded).toBe(true);
    const nan = walletScore({ netFlowRatio: NaN, top10HolderRate: NaN, distinctMakers: NaN });
    expect(nan.score).toBe(50);
    expect(nan.degraded).toBe(true);
  });

  it('weights net flow around neutral (+/-20)', () => {
    const buy = walletScore({ netFlowRatio: 1, top10HolderRate: 0.1, distinctMakers: 6 });
    expect(buy.score).toBeGreaterThan(50);
    const sell = walletScore({ netFlowRatio: -1, top10HolderRate: 0.1, distinctMakers: 6 });
    expect(sell.score).toBeLessThan(50);
  });

  it('caps the score when bundler / top-10 concentration is high (distrust)', () => {
    const clean = walletScore({ netFlowRatio: 0.8, distinctMakers: 8, top10HolderRate: 0.1 });
    const bundled = walletScore({ netFlowRatio: 0.8, distinctMakers: 8, top10HolderRate: 0.1, bundlerRate: 0.8 });
    expect(bundled.score).toBeLessThan(clean.score);
    const concentrated = walletScore({ netFlowRatio: 0.8, distinctMakers: 1, top10HolderRate: 0.95 });
    expect(concentrated.score).toBeLessThan(clean.score);
  });

  it('hydrates from GMGN track-trade rows', () => {
    const r = walletScoreFromTrades([
      { side: 'buy', amountUsd: 50000, isFullClose: false, maker: 'a' },
      { side: 'buy', amountUsd: 30000, isFullClose: false, maker: 'b' },
      { side: 'buy', amountUsd: 20000, isFullClose: false, maker: 'c' },
    ]);
    expect(r.score).toBeGreaterThan(50);
    expect(walletScoreFromTrades([]).score).toBe(50);
  });
});

describe('whaleVote enrichment feed (Q03/Q05)', () => {
  const buyHeavy = [
    { side: 'buy', amountUsd: 50000, isFullClose: false },
    { side: 'buy', amountUsd: 30000, isFullClose: false },
  ];

  it('a higher wallet-score raises the whale voter score monotonically', () => {
    const lo = whaleVote(buyHeavy as any, 0, { walletScore: 10 }).score;
    const mid = whaleVote(buyHeavy as any, 0, { walletScore: 50 }).score;
    const hi = whaleVote(buyHeavy as any, 0, { walletScore: 100 }).score;
    expect(hi).toBeGreaterThanOrEqual(mid);
    expect(mid).toBeGreaterThanOrEqual(lo);
  });

  it('does not change the vote when enrichment is absent (backward compatible)', () => {
    expect(whaleVote(buyHeavy as any, 0).score).toBe(90);
    expect(whaleVote(buyHeavy as any, 0, {}).score).toBe(90);
    expect(whaleVote(buyHeavy as any, 0, { walletScore: NaN } as any).score).toBe(90);
  });

  it('bot risk still caps the enriched score (trust gate holds)', () => {
    const capped = whaleVote(buyHeavy as any, 70, { walletScore: 100, convergence: 100 });
    expect(capped.score).toBeLessThanOrEqual(40);
  });
});
