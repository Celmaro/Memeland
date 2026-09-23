import { describe, it, expect, vi } from 'vitest';
import { DexpaprikaFeed, type DexpaprikaDrainEvent } from '../src/adapters/dexpaprika-feed.js';
import { CHAIN_NAME_TO_ID } from '../src/adapters/market-data-provider.js';

/**
 * New unified search API shape (2026-06-30 restructure): `/pools/search`
 * returns `{ results: PoolRow[] }` where PoolRow = { id, chain,
 * volume_usd_24h, liquidity_usd, tokens: [{ id (=contract), ... }] }.
 * The old `/pairs` shape (data[].pair.baseToken) is gone.
 */
function searchBody() {
  return {
    results: [
      {
        id: '0xRHPAIR',
        chain: 'robinhood',
        volume_usd_24h: 4000,
        liquidity_usd: 8000,
        price_usd: 0.5,
        tokens: [{ id: '0xRH', symbol: 'RH', name: 'Robinhood Token' }],
      },
      {
        id: '0xBSCPAIR',
        chain: 'bsc',
        volume_usd_24h: 7000,
        liquidity_usd: 15000,
        price_usd: 0.2,
        tokens: [{ id: '0xBSC', symbol: 'BSC' }],
      },
      {
        id: '0xETHPAIR',
        chain: 'ethereum',
        volume_usd_24h: 120000,
        liquidity_usd: 900000,
        price_usd: 3000,
        tokens: [{ id: '0xETH', symbol: 'ETH' }],
      }, // ethereum is now supported (eth:1 added) — NOT dropped
    ],
  };
}

function mockFetch() {
  const fn = vi.fn(async () => ({ ok: true, json: async () => searchBody() }));
  return fn as unknown as (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
}

describe('DexpaprikaFeed (PR 7 — keyless multi-chain discovery, 2026-06-30 search API)', () => {
  it('normalizes the new /pools/search results shape (id→pairAddress, tokens[0].id→address)', async () => {
    const feed = new DexpaprikaFeed({ fetch: mockFetch() });
    const tokens = await feed.discover();
    expect(tokens.length).toBe(3); // robinhood + bsc + ethereum all supported now
    const rh = tokens.find((t) => t.symbol === 'RH')!;
    expect(rh.chainId).toBe(4663);
    expect(rh.address).toBe('0xRH');
    expect(rh.pairAddress).toBe('0xRHPAIR');
    expect(rh.volume24hUsd).toBe(4000);
    expect(rh.liquidityUsd).toBe(8000);
    const eth = tokens.find((t) => t.symbol === 'ETH')!;
    expect(eth.chainId).toBe(1); // eth/ethereum mapping added in the chain fix
  });

  it('hits the new /pools/search endpoint (not the dead /pairs)', async () => {
    const f = mockFetch();
    const feed = new DexpaprikaFeed({ fetch: f });
    await feed.discover();
    const called = f.mock.calls[0][0] as string;
    expect(called).toContain('/pools/search');
    expect(called).toContain('order_by=volume_usd_24h');
    expect(called).not.toContain('/pairs');
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

  it('throws a descriptive error when the search endpoint fails (surface HTTP status)', async () => {
    const f = vi.fn(async () => ({ ok: false, json: async () => ({}) })) as unknown as (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
    const feed = new DexpaprikaFeed({ fetch: f });
    await expect(feed.discover()).rejects.toThrow(/HTTP/);
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

describe('DexpaprikaFeed — chain-id mapping fix', () => {
  it('maps ethereum and eth to chain id 1', () => {
    expect(CHAIN_NAME_TO_ID.ethereum).toBe(1);
    expect(CHAIN_NAME_TO_ID.eth).toBe(1);
  });

  it('keeps robinhood/solana/bsc/base canonical', () => {
    expect(CHAIN_NAME_TO_ID.robinhood).toBe(4663);
    expect(CHAIN_NAME_TO_ID.solana).toBe(101);
    expect(CHAIN_NAME_TO_ID.bsc).toBe(56);
    expect(CHAIN_NAME_TO_ID.base).toBe(8453);
  });
});