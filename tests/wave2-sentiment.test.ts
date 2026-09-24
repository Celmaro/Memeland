import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SentimentVoter, STRONG_ORGANIC_THRESHOLD } from '../src/agents/shared/sentiment-voter.js';
import { DexScreenerBoostsFeed } from '../src/adapters/dexscreener-boosts.js';
import type { GMGNRawToken } from '../src/adapters/gmgn-adapter.js';

// Hermetic: stub fetch so no test hits the network.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down (test stub)')));
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DEXSCREENER_BOOSTS_ENABLED;
});

function mkToken(overrides: Partial<GMGNRawToken> = {}): GMGNRawToken {
  const base = {
    chain: 'bsc' as const,
    address: '0xabcdef',
    symbol: 'TEST',
    name: 'Test',
    priceUsd: 0, marketCapUsd: 0, volume24hUsd: 0, volume1hUsd: 0, liquidityUsd: 0,
    buys: 0, sells: 0, swaps: 0, holderCount: 0,
    top10HolderRate: null, devTeamHoldRate: null, creatorClose: false, creatorTokenStatus: null,
    smartDegenCount: 0, renownedCount: 0, bundlerRate: null, ratTraderAmountRate: null,
    rugRatio: null, isWashTrading: false, isHoneypot: null, ctoFlag: false,
    renouncedMint: false, renouncedFreeze: false, creationTimestamp: null, openTimestamp: null,
    priceChange1m: null, priceChange5m: null, priceChange1h: null,
    visitingCount: 0, squareMentions: 0,
    twitterRenameCount: 0, twitterDelPostCount: 0, twitterCreateTokenCount: 0,
    buyTax: null, sellTax: null, dexscrBoostFee: 0, dexscrAd: false, totalFeeNative: null,
    exchange: null, launchpadPlatform: null, launchpadStatus: null, progress: null,
    source: 'dexscreener' as const,
  };
  return { ...base, ...overrides };
}

describe('SentimentVoter I2-1 (organic/paid split, cap, contradiction)', () => {
  const voter = new SentimentVoter(null, null); // no X, no boosts

  it('neutral when no social signal', async () => {
    const res = await voter.evaluateBatch([mkToken()]);
    const r = res.get('0xabcdef')!;
    expect(r.score).toBe(50);
    expect(r.contradiction).toBe(false);
  });

  it('organic activity raises the score; paid boost is capped and separate', async () => {
    const t = mkToken({ visitingCount: 100, squareMentions: 8, dexscrBoostFee: 100, dexscrAd: true });
    const res = await voter.evaluateBatch([t]);
    const r = res.get('0xabcdef')!;
    expect(r.contradiction).toBeFalsy();
    // organic floor 50 + visitors(+15 max) + square(+10) ; paid is separate and capped.
    expect(r.score).toBeGreaterThanOrEqual(65);
    expect(r.paidScore!).toBeLessThanOrEqual(5); // cap
    expect(r.score).toBeLessThanOrEqual(85);
  });

  it('contradiction: hype (paid boost) with NO on-chain buy flow tilts bearish & veto-fires', async () => {
    const t = mkToken({ dexscrBoostFee: 1, dexscrAd: false, buys: 0, swaps: 0 });
    const res = await voter.evaluateBatch([t]);
    const r = res.get('0xabcdef')!;
    expect(r.contradiction).toBe(true);
    expect(r.score).toBeLessThanOrEqual(40); // demerited below neutral
  });

  it('no contradiction when hype is backed by on-chain flow', async () => {
    const t = mkToken({ dexscrBoostFee: 1, buys: 50, swaps: 20 });
    const res = await voter.evaluateBatch([t]);
    const r = res.get('0xabcdef')!;
    expect(r.contradiction).toBe(false);
  });
});

describe('DexScreenerBoostsFeed (I2-2)', () => {
  it('fail-open → [] on transport error', async () => {
    const feed = new DexScreenerBoostsFeed({ fetch: vi.fn().mockRejectedValue(new Error('boom')) as never });
    expect(await feed.getBoosts()).toEqual([]);
    expect(await feed.getAds()).toEqual([]);
  });

  it('reads boosts/ads and fills the direct paid-hype set', async () => {
    const fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/token-boosts/top')) return { ok: true, json: async () => [{ tokenAddress: '0xBOOST', amount: '1.5' }] };
      return { ok: true, json: async () => [{ tokenAddress: '0xAD', amount: '0.5' }] };
    });
    const feed = new DexScreenerBoostsFeed({ fetch: fetch as never });
    const b = await feed.getBoosts();
    const a = await feed.getAds();
    expect(b).toHaveLength(1);
    expect(a).toHaveLength(1);
    expect(b[0]!.tokenAddress).toBe('0xBOOST');
  });

  it('sentiment voter detects a direct boost (vendor-free) as paid hype', async () => {
    process.env.DEXSCREENER_BOOSTS_ENABLED = 'true';
    const fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/token-boosts/top')) return { ok: true, json: async () => [{ tokenAddress: '0xabcdef', amount: '2' }] };
      return { ok: true, json: async () => [] };
    });
    const feed = new DexScreenerBoostsFeed({ fetch: fetch as never });
    const voter = new SentimentVoter(null, feed);
    const t = mkToken({ buys: 0, swaps: 0 }); // boost present, no flow
    const res = await voter.evaluateBatch([t]);
    const r = res.get('0xabcdef')!;
    // direct boost registered → paidScore capped > 0 and contradiction (no on-chain flow)
    expect(r.contradiction).toBe(true);
    expect(r.paidScore!).toBeGreaterThan(0);
  });
});