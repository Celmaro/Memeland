import { describe, it, expect } from 'vitest';
import {
  rankTradersByRealizedPnl,
  traderConcentration,
  detectBundles,
  BalanceBatchReader,
  retryWithBackoff,
  dedupMerge,
  sizeAndPaperCopyTrade,
  type WalletTradeRecord,
} from '../src/services/wallet-tracker.js';

const sampleTrades: WalletTradeRecord[] = [
  { wallet: 'wA', token: 'TOK', side: 'sell', usd: 5000, pnlUsd: 2000 },
  { wallet: 'wA', token: 'TOK', side: 'sell', usd: 1000, pnlUsd: -300 },
  { wallet: 'wB', token: 'TOK', side: 'sell', usd: 800, pnlUsd: 100 },
  { wallet: 'wC', token: 'OTHER', side: 'sell', usd: 12000, pnlUsd: 6000 },
];

describe('rankTradersByRealizedPnl', () => {
  it('ranks wallets by realized PnL descending and computes win rate', () => {
    const ranked = rankTradersByRealizedPnl(sampleTrades);
    expect(ranked.map((r) => r.wallet)).toEqual(['wC', 'wA', 'wB']);
    const a = ranked.find((r) => r.wallet === 'wA')!;
    expect(a.realizedPnlUsd).toBeCloseTo(1700, 6);
    expect(a.trades).toBe(2);
    expect(a.winRatePct).toBeCloseTo(50, 6);
  });

  it('returns an empty list for no trades', () => {
    expect(rankTradersByRealizedPnl([])).toEqual([]);
  });
});

describe('sizeAndPaperCopyTrade (SRC-108 copy-trade wiring)', () => {
  it('sizes a proportional paper fill from a leader multiplier and records it', async () => {
    const result = await sizeAndPaperCopyTrade('COPYTOK', 2, 0.5, {
      baseNotionalUsd: 100,
      maxNotionalUsd: 500,
      minNotionalUsd: 10,
    });

    expect(result.suggestedUsd).toBe(200);
    expect(result.accepted).toBe(true);
    expect(result.fill).toMatchObject({
      tokenAddress: 'COPYTOK',
      side: 'buy',
      sizeUsd: 200,
      sequence: 1,
    });
  });

  it('fails closed without recording a fill on invalid copy sizing inputs', async () => {
    const result = await sizeAndPaperCopyTrade('COPYTOK', -2, 0.5);

    expect(result.suggestedUsd).toBe(0);
    expect(result.accepted).toBe(false);
    expect(result.fill).toBeUndefined();
    expect(result.reason).toContain('invalid');
  });
});

describe('traderConcentration', () => {
  it('reports the top-N share of total traded USD', () => {
    const c = traderConcentration(sampleTrades, 1);
    // total usd = 5000+1000+800+12000 = 18800 ; top1 = wC 12000
    expect(c.totalUsd).toBeCloseTo(18800, 6);
    expect(c.topNUsd).toBeCloseTo(12000, 6);
    expect(c.concentrationPct).toBeCloseTo(12000 / 18800 * 100, 6);
    expect(c.topWallets[0]!.wallet).toBe('wC');
  });

  it('is fail-closed (null) when there is no volume', () => {
    expect(traderConcentration([], 1).concentrationPct).toBeNull();
  });
});

describe('detectBundles', () => {
  it('groups multiple wallets buying the same token within a time window', () => {
    const bundles = detectBundles([
      { wallet: 'w1', token: 'TOK', side: 'buy', usd: 100, blockTime: 1000 },
      { wallet: 'w2', token: 'TOK', side: 'buy', usd: 200, blockTime: 1005 },
      { wallet: 'w3', token: 'TOK', side: 'buy', usd: 300, blockTime: 1090 }, // outside 60s window
      { wallet: 'w4', token: 'OTHER', side: 'buy', usd: 50, blockTime: 1002 },
    ], { windowSec: 60, minWallets: 2 });
    const tokBundle = bundles.find((b) => b.token === 'TOK')!;
    expect(tokBundle).toBeDefined();
    expect(tokBundle.wallets).toEqual(['w1', 'w2']);
    expect(bundles.some((b) => b.token === 'OTHER')).toBe(false);
  });

  it('returns [] when fewer than minWallets buy together', () => {
    const bundles = detectBundles([
      { wallet: 'w1', token: 'TOK', side: 'buy', usd: 100, blockTime: 1000 },
      { wallet: 'w2', token: 'TOK', side: 'buy', usd: 200, blockTime: 1005 },
    ], { windowSec: 60, minWallets: 3 });
    expect(bundles).toEqual([]);
  });
});

describe('BalanceBatchReader in-flight dedupe', () => {
  it('dedupes concurrent reads of the same key to one underlying call', async () => {
    let calls = 0;
    const reader = new BalanceBatchReader(async (_chain, _token, _owner) => {
      calls++;
      return 1000n;
    });
    const [a, b] = await Promise.all([
      reader.read('robinhood', '0xAAA', '0x111'),
      reader.read('robinhood', '0xaaa', '0x111'),
    ]);
    expect(a).toBe(1000n);
    expect(b).toBe(1000n);
    expect(calls).toBe(1);
  });

  it('readMany maps each request and treats failures as null', async () => {
    const reader = new BalanceBatchReader(async (_c, token) =>
      token === '0xBAD' ? null : 500n
    );
    const map = await reader.readMany([
      { chain: 'robinhood', token: '0xAAA', owner: '0x111' },
      { chain: 'robinhood', token: '0xBAD', owner: '0x111' },
    ]);
    expect(map.get('robinhood:0xaaa:0x111')).toBe(500n);
    expect(map.get('robinhood:0xbad:0x111')).toBeNull();
  });
});

describe('retryWithBackoff (kol-quest 429 backoff)', () => {
  it('retries on a retryable 429 then succeeds', async () => {
    let attempts = 0;
    const result = await retryWithBackoff(async () => {
      attempts++;
      if (attempts < 3) {
        const err = new Error('rate limited') as Error & { status?: number };
        err.status = 429;
        throw err;
      }
      return 'ok';
    }, { maxRetries: 3, baseMs: 1, maxMs: 2 });
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('gives up after maxRetries and rethrows', async () => {
    let attempts = 0;
    await expect(retryWithBackoff(async () => {
      attempts++;
      const err = new Error('boom') as Error & { status?: number };
      err.status = 500;
      throw err;
    }, { maxRetries: 2, baseMs: 1, maxMs: 2 })).rejects.toThrow('boom');
    expect(attempts).toBe(2);
  });

  it('does not retry non-retryable errors', async () => {
    let attempts = 0;
    await expect(retryWithBackoff(async () => {
      attempts++;
      const err = new Error('bad') as Error & { status?: number };
      err.status = 400;
      throw err;
    }, { maxRetries: 3, baseMs: 1, maxMs: 2 })).rejects.toThrow('bad');
    expect(attempts).toBe(1);
  });
});

describe('dedupMerge (idempotent poll+ingest)', () => {
  it('merges incoming records by key, later records win', () => {
    const merged = dedupMerge(
      new Map([['a', { id: 'a', val: 1 }], ['b', { id: 'b', val: 2 }]]),
      [{ id: 'b', val: 20 }, { id: 'c', val: 3 }],
      (r) => r.id
    );
    expect(merged.get('a')!.val).toBe(1);
    expect(merged.get('b')!.val).toBe(20);
    expect(merged.get('c')!.val).toBe(3);
  });
});
