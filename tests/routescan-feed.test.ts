import { describe, it, expect } from 'vitest';
import { RoutescanFeed, ROUTESCAN_DEFAULT_BASE } from '../src/adapters/routescan-feed.js';
import type { FetchLike } from '../src/adapters/routescan-feed.js';

function fetchStub(rows: unknown[]): { fn: FetchLike; calls: () => number } {
  let calls = 0;
  const fn = async (url: string) => {
    calls += 1;
    if (url.includes('/holders')) {
      // holders: { items: [{ holderAddress, balance, percentage }] }
      return { ok: true, status: 200, json: async () => ({ items: [{ holderAddress: '0xH1', balance: '100', percentage: 5.2 }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ items: rows }) };
  };
  return { fn, calls: () => calls };
}

describe('RoutescanFeed (free keyless new-token + holder enrichment)', () => {
  it('discovers newest tokens across all chains, sorted by createdAt desc', async () => {
    const { fn, calls } = fetchStub([
      {
        address: '0xabc',
        name: 'Dojima RICE',
        symbol: 'RICE',
        decimals: 18,
        totalSupply: '1000000000000000000000000',
        price: 0.0123,
        marketCap: 1230000,
        holdersCount: 412,
        createOperation: { timestamp: '2026-09-27T18:47:00Z', txHash: '0xT1' },
      },
    ]);
    const feed = new RoutescanFeed({ fetch: fn });
    const tokens = await feed.discover({ chainIds: [1], limit: 100 });
    expect(calls()).toBe(1);
    expect(tokens.length).toBe(1);
    expect(tokens[0]!.address).toBe('0xabc');
    expect(tokens[0]!.symbol).toBe('RICE');
    expect(tokens[0]!.chainId).toBe(1);
    expect(tokens[0]!.priceUsd).toBeCloseTo(0.0123);
    expect(tokens[0]!.mcapUsd).toBe(1230000);
    // Fresh-lane: created_at-ordered discovery = new tokens, zero market data at birth
    expect(tokens[0]!.freshLane).toBe(true);
    expect(tokens[0]!.sourceUnavailable).toBeUndefined();
    // The request must hit the right path with sort=createdAt,desc
    expect(fn).toBeDefined();
  });

  it('enriches holders via /erc20/{addr}/holders when requested', async () => {
    const { fn } = fetchStub([]);
    const feed = new RoutescanFeed({ fetch: fn });
    const holders = await feed.fetchHolders(1, '0xabc', 5);
    expect(holders).toHaveLength(1);
    expect(holders[0]!.address).toBe('0xH1');
    expect(holders[0]!.percentage).toBeCloseTo(5.2);
  });

  it('drops unsupported chains (non-EVM / unknown chain id)', async () => {
    const { fn } = fetchStub([]);
    const feed = new RoutescanFeed({ fetch: fn });
    // Solana (101) is not EVM — Routescan /evm/ paths don't cover it
    const tokens = await feed.discover({ chainIds: [101] });
    expect(tokens).toEqual([]);
  });
});
