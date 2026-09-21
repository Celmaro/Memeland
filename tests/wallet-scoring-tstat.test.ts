import { describe, expect, it } from 'vitest';
import {
  walletTStat,
  botManipulationScore,
  walletScoreWithReputation,
  type BotTrade,
} from '../src/services/wallet-scoring.js';
import { ReputationMemory, type AegisSnapshot, type WalletProfile } from '../src/services/reputation-memory.js';

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

describe('walletScoreWithReputation (Kernel A wiring)', () => {
  const snapshot: AegisSnapshot = {
    mintAuthority: true,
    freezeAuthority: false,
    topHolderConcPct: 35,
    bundleDetected: true,
    lpStatus: 'none',
    metadataFlags: false,
  };

  it('docks the wallet score when the deployer has a known-rugged record', () => {
    const reputation = new ReputationMemory();
    reputation.setDeployerKnown('0xRUG', 'rugged');
    const profile: WalletProfile = { ageDays: 30, historyCount: 12 };

    const result = walletScoreWithReputation(
      { netFlowRatio: 0.8, top10HolderRate: 0.2, distinctMakers: 6 },
      reputation,
      'TOKEN',
      '0xRUG',
      profile,
      snapshot,
    );

    expect(result.reputationScore).toBeLessThan(60);
    expect(result.score).toBeLessThan(result.walletScore);
    expect(result.tag).toBe('KNOWN_RUGGER');
    expect(result.reasons.some((r) => r.includes('known-rugged'))).toBe(true);
  });

  it('keeps missing wallet inputs fail-closed even when reputation is clean', () => {
    const reputation = new ReputationMemory();
    reputation.setDeployerKnown('0xGOOD', 'good');
    const profile: WalletProfile = { ageDays: 200, historyCount: 40 };

    const result = walletScoreWithReputation(
      {},
      reputation,
      'TOKEN',
      '0xGOOD',
      profile,
      { ...snapshot, mintAuthority: false, topHolderConcPct: 10, bundleDetected: false },
    );

    expect(result.walletScore).toBe(50); // neutral baseline
    expect(result.degraded).toBe(true);
    expect(result.tag).toBe('ESTABLISHED');
    expect(result.reputationScore).toBeGreaterThan(60);
  });
});
