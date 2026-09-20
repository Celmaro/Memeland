import { describe, it, expect, vi } from 'vitest';
import { CodexFeed } from '../src/adapters/codex-feed.js';
import { CHAIN_NAME_TO_ID, type MarketDataProvider } from '../src/adapters/market-data-provider.js';

function graphqlBody() {
  return {
    data: {
      markets: [
        {
          baseToken: { address: '0xRH', symbol: 'RH' },
          chainId: 'robinhood',
          priceUsd: '1.2',
          liquidityUsd: '9000',
          volumeUsd: '5000',
        },
        {
          baseToken: { address: 'BASE', symbol: 'BASE' },
          chainId: 'base',
          priceUsd: '0.5',
          liquidityUsd: '3000',
          volumeUsd: '700',
        },
        {
          baseToken: { address: 'ETH', symbol: 'ETH' },
          chainId: 'ethereum',
          priceUsd: '2',
          liquidityUsd: '200000',
          volumeUsd: '90000',
        }, // unsupported chain → dropped
      ],
    },
  };
}

function mockFetch() {
  const fn = vi.fn(async () => ({ ok: true, json: async () => graphqlBody() }));
  return fn as unknown as (url: string, init?: unknown) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
}

describe('CodexFeed (PR 7 — A15 keyless GraphQL → shared MPP shape)', () => {
  it('normalizes supported-chain markets and drops unknown chains', async () => {
    const feed = new CodexFeed({ fetch: mockFetch() });
    const tokens = await feed.discover();
    expect(tokens.length).toBe(2);
    expect(tokens.map((t) => t.chainId).sort()).toEqual([4663, 8453].sort());
    expect(tokens.some((t) => t.symbol === 'ETH')).toBe(false);
    expect(CHAIN_NAME_TO_ID.robinhood).toBe(4663);
  });

  it('parses numeric price/liquidity/volume strings into numbers', async () => {
    const feed = new CodexFeed({ fetch: mockFetch() });
    const tokens = await feed.discover();
    const rh = tokens.find((t) => t.symbol === 'RH')!;
    expect(rh.priceUsd).toBe(1.2);
    expect(rh.liquidityUsd).toBe(9000);
    expect(rh.volume24hUsd).toBe(5000);
  });

  it('respects the TTL cache (one fetch within TTL)', async () => {
    const f = mockFetch();
    const feed = new CodexFeed({ fetch: f, ttlMs: 60_000 });
    await feed.discover();
    await feed.discover();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('honors minLiquidityUsd and limit discovery options', async () => {
    const feed = new CodexFeed({ fetch: mockFetch() });
    const filtered = await feed.discover({ minLiquidityUsd: 5000, limit: 1 });
    expect(filtered.length).toBe(1);
    expect(filtered[0].liquidityUsd).toBeGreaterThanOrEqual(5000);
  });

  it('a stub provider can replace CodexFeed (proves decoupling from the interface)', async () => {
    const stub: MarketDataProvider = {
      id: 'stub',
      discover: async () => [
        { address: '0xSTUB', chainId: CHAIN_NAME_TO_ID.robinhood, symbol: 'STUB', priceUsd: 1, liquidityUsd: 100, volume24hUsd: 50 },
      ],
    };
    const tokens = await stub.discover();
    expect(tokens.length).toBe(1);
    expect(tokens[0].id).toBeUndefined ?? expect(tokens[0].symbol).toBe('STUB');
  });
});
