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

function mockFetch() {
  const fn = vi.fn(async () => ({ ok: true, json: async () => profiles() }));
  return fn as unknown as (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
}

describe('DexScreenerFeed (Q06)', () => {
  it('returns normalized tokens for RH/BSC/Base/Solana (and drops unknown chains)', async () => {
    const feed = new DexScreenerFeed({ fetch: mockFetch() });
    const tokens = await feed.discover();
    expect(tokens.length).toBe(4);
    expect(tokens.map((t) => t.chainId).sort()).toEqual([56, 101, 4663, 8453].sort());
    expect(tokens.some((t) => t.symbol === 'ETH')).toBe(false);
    // CHAIN_NAME_TO_ID stays canonical.
    expect(CHAIN_NAME_TO_ID.robinhood).toBe(4663);
    expect(CHAIN_NAME_TO_ID.solana).toBe(101);
  });

  it('respects the TTL cache (one fetch within TTL)', async () => {
    const f = mockFetch();
    const feed = new DexScreenerFeed({ fetch: f, ttlMs: 60_000 });
    await feed.discover();
    await feed.discover();
    await feed.discover();
    expect(f).toHaveBeenCalledTimes(1);
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
    const dexscreener = new DexScreenerFeed({ fetch: mockFetch() });
    expect(await consume(stub)).toBe(1);
    expect(await consume(dexscreener)).toBeGreaterThan(0);
  });
});
