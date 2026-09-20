import { describe, it, expect, vi } from 'vitest';
import { DexpaprikaFeed, type DexpaprikaDrainEvent } from '../src/adapters/dexpaprika-feed.js';
import { CHAIN_NAME_TO_ID } from '../src/adapters/market-data-provider.js';

function pairsBody() {
  return {
    data: [
      {
        chain: 'robinhood',
        pair: { address: '0xRHPAIR', baseToken: { address: '0xRH', symbol: 'RH' } },
        liquidityUsd: '8000',
        volumeUsd24: '4000',
      },
      {
        chain: 'bsc',
        pair: { address: '0xBSC', baseToken: { address: '0xBSC', symbol: 'BSC' } },
        liquidityUsd: '15000',
        volumeUsd24: '7000',
      },
      {
        chain: 'ethereum',
        pair: { address: '0xETH', baseToken: { address: '0xETH', symbol: 'ETH' } },
        liquidityUsd: '900000',
        volumeUsd24: '120000',
      }, // unsupported chain → dropped
    ],
  };
}

function mockFetch() {
  const fn = vi.fn(async () => ({ ok: true, json: async () => pairsBody() }));
  return fn as unknown as (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
}

describe('DexpaprikaFeed (PR 7 — keyless multi-chain discovery)', () => {
  it('normalizes supported chains and drops unsupported ones', async () => {
    const feed = new DexpaprikaFeed({ fetch: mockFetch() });
    const tokens = await feed.discover();
    expect(tokens.length).toBe(2);
    expect(tokens.map((t) => t.chainId).sort()).toEqual([56, 4663].sort());
    expect(tokens.some((t) => t.symbol === 'ETH')).toBe(false);
  });

  it('respects the TTL cache', async () => {
    const f = mockFetch();
    const feed = new DexpaprikaFeed({ fetch: f, ttlMs: 60_000 });
    await feed.discover();
    await feed.discover();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('honors minLiquidityUsd and limit', async () => {
    const feed = new DexpaprikaFeed({ fetch: mockFetch() });
    const tokens = await feed.discover({ minLiquidityUsd: 10000, limit: 1 });
    expect(tokens.length).toBe(1);
    expect(tokens[0].liquidityUsd).toBeGreaterThanOrEqual(10000);
  });
});

describe('DexpaprikaFeed drain detection (SSE reserve-streaming Adapt)', () => {
  it('classifies a drain event when liquidity drops below the prior balance', () => {
    const feed = new DexpaprikaFeed({ fetch: mockFetch() });
    const ev: DexpaprikaDrainEvent = feed.drainEvent({
      pairAddress: '0xRHPAIR',
      chain: 'robinhood',
      prevLiquidityUsd: 10000,
      currLiquidityUsd: 2500,
    });
    expect(ev.drained).toBe(true);
    expect(ev.dropPct).toBe(75);
  });

  it('does not flag a normal small reserve move', () => {
    const feed = new DexpaprikaFeed({ fetch: mockFetch() });
    const ev = feed.drainEvent({
      pairAddress: '0xRHPAIR',
      chain: 'robinhood',
      prevLiquidityUsd: 10000,
      currLiquidityUsd: 9800,
    });
    expect(ev.drained).toBe(false);
  });
});
