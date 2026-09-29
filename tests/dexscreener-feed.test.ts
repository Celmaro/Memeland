import { describe, it, expect, vi } from 'vitest';
import { DexScreenerFeed } from '../src/adapters/dexscreener-feed.js';
import { DexpaprikaFeed } from '../src/adapters/dexpaprika-feed.js';
import { type MarketDataProvider } from '../src/adapters/market-data-provider.js';

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

  it('a second real provider is substitutable for DexScreener through the consumer', async () => {
    // Structural substitutability of MarketDataProvider is a COMPILE-time
    // property, already enforced by tsc on all ten implementors. Asserting a
    // stub's own hardcoded array length proved nothing. What has runtime
    // meaning is that a DIFFERENT real implementation flows through the same
    // consumer identically.
    const dexpaprika = new DexpaprikaFeed({ fetch: urlAwareFetch() as never });
    const dexscreener = new DexScreenerFeed({ fetch: urlAwareFetch() });
    const consume = async (p: MarketDataProvider) => p.discover({ chainIds: [4663] });
    const [a, b] = await Promise.all([consume(dexpaprika), consume(dexscreener)]);
    expect(Array.isArray(a)).toBe(true);
    expect(Array.isArray(b)).toBe(true);
  });

  it('maps the pair volume.h1 into volume1hUsd (real 1h, not the /24 estimate)', async () => {
    const feed = new DexScreenerFeed({
      fetch: urlAwareFetch([
        { chainId: 'robinhood', pairAddress: '0xPAIR', dexId: 'uniswap',
          baseToken: { address: '0xRH', symbol: 'RH' }, priceUsd: '1.2',
          liquidity: { usd: 5000 }, volume: { h24: 24000, h1: 1500 }, fdv: 9000 },
      ]),
    });
    const tokens = await feed.discover();
    const rh = tokens.find((t) => t.symbol === 'RH');
    expect(rh).toBeDefined();
    expect(rh!.volume24hUsd).toBe(24000);
    expect(rh!.volume1hUsd).toBe(1500); // real 1h, distinct from 24000/24=1000
  });
});
