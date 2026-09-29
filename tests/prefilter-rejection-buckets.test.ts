import { describe, it, expect } from 'vitest';
import { preFilterToken } from '../src/agents/shared/gmgn-meme-helpers.js';
import type { GMGNRawToken } from '../src/adapters/gmgn-adapter.js';

/**
 * Owner test for the [PREFILTER REJECTS] diagnostic.
 *
 * The production bucket map is private (it only logs). Per the authoring gate
 * that would be a test-only seam, so this proves the SAME contract at the
 * boundary that produces the strings: a real token rejected by each distinct
 * fail-closed floor yields a reason the bucket map must classify differently.
 *
 * Why this matters: the whole point of the distribution is telling a dead feed
 * apart from a $50k volume bar. If `sourceUnavailable` collapsed into
 * 'volume-floor', the diagnostic would actively mislead an operator — which is
 * the exact I1-4 `UNAVAILABLE != 0` error class, one layer up.
 */
describe('[PREFILTER REJECTS] bucket discrimination (I1-4 UNAVAILABLE != 0)', () => {
  const config = {
    minVolume1hUsd: 50_000,
    minLiquidityUsd: 10_000,
    minMarketCapUsd: 100_000,
    minTotalFeeUsd: 0,
    minAgeHours: 0,
    minFreshVolume1hUsd: 3_000,
    maxRugRatio: 0.3,
    maxRatTraderRate: 0.5,
    maxTop10HolderRate: 0.4,
  } as any;

  const token = (over: Partial<GMGNRawToken> = {}): GMGNRawToken => ({
    symbol: 'TKN', address: '0xabc', chainId: 8453, source: 'gecko',
    priceUsd: 0.001, liquidityUsd: 50_000, volume1hUsd: 60_000, volume24hUsd: 200_000,
    marketCapUsd: 200_000, socialHypeScore: 50, securityAuditPassed: true,
    totalFeeNative: null, creationTimestamp: null, ...over,
  } as unknown as GMGNRawToken);

  it('a dead feed is NOT reported as a volume rejection', () => {
    const r = preFilterToken(token({ sourceUnavailable: true, volume1hUsd: 0, liquidityUsd: 0 }), config, 1);
    expect(r.ok).toBe(false);
    // The reason must name the outage, so the bucket map (which tests
    // 'unavailable' first) classifies it as feed-down, not volume-floor.
    expect(r.reason).toContain('unavailable');
    expect(r.reason).not.toMatch(/volume 1h \$0\.0k < /);
  });

  it('a genuine low-volume token IS reported as a volume rejection', () => {
    const r = preFilterToken(token({ volume1hUsd: 5_000 }), config, 1);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('volume 1h');
  });

  it('liquidity, market-cap, and volume rejections are three distinct reasons', () => {
    const vol = preFilterToken(token({ volume1hUsd: 1_000 }), config, 1).reason;
    const liq = preFilterToken(token({ liquidityUsd: 1_000 }), config, 1).reason;
    const mcap = preFilterToken(token({ marketCapUsd: 1_000 }), config, 1).reason;
    expect(vol).toContain('volume 1h');
    expect(liq).toContain('liq $');
    expect(mcap).toContain('market cap');
    // Each must be classifiable without ambiguity — the distribution relies on it.
    expect(new Set([vol, liq, mcap]).size).toBe(3);
  });

  it('a fully-qualified candidate still passes (the buckets only classify rejections)', () => {
    expect(preFilterToken(token(), config, 1).ok).toBe(true);
  });
});
