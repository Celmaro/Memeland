import { describe, expect, it } from 'vitest';
import {
  walletTStat,
  botManipulationScore,
  type BotTrade,
} from '../src/services/wallet-scoring.js';

function trade(overrides: Partial<BotTrade> & { side: 'buy' | 'sell' }): BotTrade {
  return { amountUsd: 100, side: overrides.side, ...overrides };
}

describe('walletTStat profitability filter (SRC-142 copytrading)', () => {
  it('is fail-closed with fewer than two returns', () => {
    expect(walletTStat([]).t).toBeNull();
    expect(walletTStat([0.02]).t).toBeNull();
  });

  it('is fail-closed on a zero-variance series', () => {
    expect(walletTStat([0.02, 0.02, 0.02]).t).toBeNull();
  });

  it('reports a positive t when the edge is consistently profitable', () => {
    const { t } = walletTStat([0.02, 0.03, 0.025, 0.02, 0.03]);
    expect(t).not.toBeNull();
    expect(t as number).toBeGreaterThan(2);
  });

  it('reports a non-positive t on a losing series', () => {
    const { t } = walletTStat([-0.02, -0.01, -0.03, -0.015]);
    expect(t).not.toBeNull();
    expect(t as number).toBeLessThan(0);
  });
});

describe('botManipulationScore (SRC-142 bot-manipulation features)', () => {
  it('is neutral + degraded with no buys', () => {
    const r = botManipulationScore([trade({ side: 'sell', amountUsd: 50 })]);
    expect(r.risk).toBe(0);
    expect(r.degraded).toBe(true);
  });

  it('flags uniform sizing + single-maker concentration', () => {
    const r = botManipulationScore(
      Array.from({ length: 8 }, (_, i) =>
        trade({ side: 'buy', amountUsd: 100, maker: '0xbot', at: i * 1000 }),
      ),
    );
    expect(r.features.uniformSizeRate).toBe(1);
    expect(r.features.topMakerBuyRate).toBe(1);
    expect(r.risk).toBeGreaterThanOrEqual(50);
  });

  it('flags a burst of buys inside a one-minute window', () => {
    const r = botManipulationScore([
      trade({ side: 'buy', amountUsd: 100, at: 0 }),
      trade({ side: 'buy', amountUsd: 120, at: 10_000 }),
      trade({ side: 'buy', amountUsd: 90, at: 20_000 }),
      trade({ side: 'buy', amountUsd: 110, at: 30_000 }),
      trade({ side: 'buy', amountUsd: 105, at: 40_000 }),
    ]);
    expect(r.features.maxBurstRate).toBe(1);
  });

  it('stays low for organic, varied flow', () => {
    const now = 1_000_000;
    const r = botManipulationScore([
      trade({ side: 'buy', amountUsd: 137, maker: 'a', at: now }),
      trade({ side: 'buy', amountUsd: 852, maker: 'b', at: now + 120_000 }),
      trade({ side: 'buy', amountUsd: 411, maker: 'c', at: now + 240_000 }),
      trade({ side: 'buy', amountUsd: 620, maker: 'd', at: now + 360_000 }),
    ]);
    expect(r.risk).toBe(0);
    expect(r.degraded).toBe(false);
  });
});
