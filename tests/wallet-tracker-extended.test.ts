import { afterEach, describe, it, expect } from 'vitest';
import {
  rankTradersByRealizedPnl,
  traderConcentration,
  detectBundles,
  BalanceBatchReader,
  retryWithBackoff,
  dedupMerge,
  CopyTradeHesitation,
  sizeAndPaperCopyTrade,
  sizeCopyTradeGuarded,
  assessSolanaTimeOnCurve,
  sizeCopyByGarchVol,
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

describe('CopyTradeHesitation + sizeCopyTradeGuarded (SRC-155 memory wiring)', () => {
  it('flags a copy target until a later clear resolves the contradiction', async () => {
    let now = 1_000;
    const hesitation = new CopyTradeHesitation(() => now);
    hesitation.flag('HESITOK', { agent: 'security', claim: 'honeypot suspicion', createdAt: now, weight: 0.9 });
    now = 2_000;
    hesitation.clear('HESITOK', { agent: 'auditor', claim: 'confirmed safe', createdAt: now, weight: 0.95 });

    const brief = hesitation.brief('HESITOK');
    expect(brief.status).toBe('CLEARED');
    expect(brief.conflicts).toHaveLength(1);
    expect(brief.conflicts[0].winnerId).toContain('clear');

    const result = await sizeCopyTradeGuarded('HESITOK', 2, 0.5, hesitation, {
      baseNotionalUsd: 100,
      maxNotionalUsd: 500,
      minNotionalUsd: 10,
    });
    expect(result.status).toBe('CLEARED');
    expect(result.accepted).toBe(true);
    expect(result.suggestedUsd).toBe(200);
  });

  it('blocks the copy before paper-filling when the target is flagged', async () => {
    const hesitation = new CopyTradeHesitation(() => 0);
    hesitation.flag('BLOCKEDTOK', { createdAt: 0, claim: 'flagged copy target' });

    const result = await sizeCopyTradeGuarded('BLOCKEDTOK', 2, 0.5, hesitation);
    expect(result.status).toBe('FLAGGED');
    expect(result.accepted).toBe(false);
    expect(result.fill).toBeUndefined();
    expect(result.reason).toContain('FLAGGED');
  });

  it('expires stale hesitation entries so the copy proceeds again', async () => {
    let now = 0;
    const hesitation = new CopyTradeHesitation(() => now);
    hesitation.flag('STALETOK', { createdAt: 0, ttlMs: 5_000, claim: 'old flag' });
    now = 6_000;

    const result = await sizeCopyTradeGuarded('STALETOK', 2, 0.5, hesitation);
    expect(hesitation.brief('STALETOK').status).toBe('NO_MEMORY');
    expect(result.status).toBe('NO_MEMORY');
    expect(result.accepted).toBe(true);
  });
});

describe('assessSolanaTimeOnCurve (SRC-106 SOL-only wiring)', () => {
  afterEach(() => {
    delete process.env.MULTICHAIN_CHAINS;
  });

  it('runs the time-on-curve filter with the wallet-tracker loader contract', async () => {
    const graduatedAtMs = 100_000;
    const loader = async (cursor: string | null) => {
      if (cursor !== null) return { signatures: [], nextCursor: null, truncated: false };
      return {
        signatures: [{ blockTimeMs: graduatedAtMs - 3 * 60 * 60 * 1000 }],
        nextCursor: null,
        truncated: false,
      };
    };

    const result = await assessSolanaTimeOnCurve('SOLTOK', graduatedAtMs, loader, {
      chains: ['sol'],
    });
    expect(result.enabled).toBe(true);
    expect(result.organic).toBe(true);
    expect(result.timeOnCurveHours).toBeCloseTo(3, 6);
  });

  it('respects the MULTICHAIN_CHAINS gate when sol is not configured', async () => {
    process.env.MULTICHAIN_CHAINS = 'bsc';
    const result = await assessSolanaTimeOnCurve(
      'SOLTOK',
      100_000,
      async () => ({ signatures: [], nextCursor: null, truncated: false }),
    );
    expect(result.enabled).toBe(false);
    expect(result.organic).toBe(false);
    expect(result.evidence.some((e) => e.includes('MULTICHAIN_CHAINS'))).toBe(true);
  });

  it('fails closed when the first transaction history is unreadable', async () => {
    const result = await assessSolanaTimeOnCurve(
      'GHOST',
      100_000,
      async () => ({ signatures: [], nextCursor: null, truncated: false }),
      { chains: ['sol'] },
    );
    expect(result.enabled).toBe(true);
    expect(result.organic).toBe(false);
    expect(result.evidence.some((e) => e.includes('unreadable'))).toBe(true);
  });
});

describe('sizeCopyByGarchVol (Q14 GARCH walk-forward wiring)', () => {
  const garchParams = { omega: 0.01, alpha: 0.15, beta: 0.8 };

  it('sizes a copy by an honestly validated walk-forward vol forecast', () => {
    const lowVol = Array.from({ length: 40 }, (_, i) => Math.sin(i * 0.7) * 0.02);
    const highVol = Array.from({ length: 40 }, (_, i) => Math.sin(i * 0.7) * 0.8);

    const low = sizeCopyByGarchVol(lowVol, garchParams, 1000, 20);
    const high = sizeCopyByGarchVol(highVol, garchParams, 1000, 20);

    expect(low.validated).toBe(true);
    expect(low.forecastVolPct).not.toBeNull();
    expect(low.suggestedUsd).toBeGreaterThan(0);
    expect(high.validated).toBe(true);
    expect(high.forecastVolPct).not.toBeNull();
    expect(high.suggestedUsd).toBeLessThanOrEqual(low.suggestedUsd);
    expect(high.suggestedUsd).toBeLessThan(1000);
  });

  it('fails closed before sizing when the vol estimate cannot be validated', () => {
    const result = sizeCopyByGarchVol([0.1, 0.2], garchParams, 1000, 20);
    expect(result.validated).toBe(false);
    expect(result.suggestedUsd).toBe(0);
    expect(result.reason).toContain('too few returns');
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
