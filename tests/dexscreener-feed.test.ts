import { describe, it, expect, vi } from 'vitest';
import { DexScreenerFeed } from '../src/adapters/dexscreener-feed.js';
import { CHAIN_NAME_TO_ID, type MarketDataProvider } from '../src/adapters/market-data-provider.js';

function profiles() {
  return {
    tokenProfiles: [
      { chainId: 'robinhood', tokenAddress: '0xRH', symbol: 'RH' },
      { chainId: 'bsc', tokenAddress: '0xBSC', symbol: 'BSC' },
      { chainId: 'base', tokenAddress: '0xBASE', symbol: 'BASE' },
      { chainId: 'solana', tokenAddress: 'SOL', symbol: 'SOL' },
      { chainId: 'ethereum', tokenAddress: '0xETH', symbol: 'ETH' }, // unsupported → dropped
    ],
  };
}

function urlAwareFetch(pairs: unknown[] = []) {
  const fn = vi.fn(async (url: string) => {
    if (url.includes('/latest/dex/tokens')) return { ok: true, json: async () => ({ pairs }) };
    return { ok: true, json: async () => profiles() };
  });
  return fn as unknown as (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
}

describe('DexScreenerFeed (Q06)', () => {
  it('returns normalized tokens for RH/BSC/Base/Solana/ETH (chain filter fixed to keep eth)', async () => {
    const feed = new DexScreenerFeed({ fetch: urlAwareFetch() });
    const tokens = await feed.discover();
    // eth is a real target chain (AGENTS.md): the old raw-name filter dropped
    // 'ethereum'; the fix resolves via canonical chain-id so it survives.
    expect(tokens.length).toBe(5);
    expect(tokens.map((t) => t.chainId).sort()).toEqual([1, 56, 101, 4663, 8453].sort());
    expect(tokens.some((t) => t.symbol === 'ETH')).toBe(true);
    // CHAIN_NAME_TO_ID stays canonical.
    expect(CHAIN_NAME_TO_ID.robinhood).toBe(4663);
    expect(CHAIN_NAME_TO_ID.solana).toBe(101);
  });

  it('respects the TTL cache (profiles + enrichment each fetched once within TTL)', async () => {
    const f = urlAwareFetch();
    const feed = new DexScreenerFeed({ fetch: f, ttlMs: 60_000 });
    await feed.discover();
    await feed.discover();
    await feed.discover();
    // One profiles fetch + one enrichment fetch across 3 discover calls (cached).
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('a stub provider can replace DexScreener (proves decoupling from the interface)', async () => {
    const stub: MarketDataProvider = {
      id: 'stub',
      async discover() {
        return [{ address: '0xSTUB', chainId: 4663, symbol: 'STUB', priceUsd: 1, liquidityUsd: 1000, volume24hUsd: 500 }];
      },
    };
    // A consumer typed against the interface accepts either implementation.
    const consume = async (p: MarketDataProvider) => (await p.discover({ chainIds: [4663] })).length;
    const dexscreener = new DexScreenerFeed({ fetch: urlAwareFetch() });
    expect(await consume(stub)).toBe(1);
    expect(await consume(dexscreener)).toBeGreaterThan(0);
  });
});
