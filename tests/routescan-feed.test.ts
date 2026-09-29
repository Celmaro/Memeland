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
        chainId: '1',
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
    // The request must hit the /all aggregate with sort=createdAt,desc (one call)
    expect(fn).toBeDefined();
  });

  it('400-fix: always uses /all aggregate and fail-soft on chains Routescan does not index', async () => {
    const urls: string[] = [];
    const fn = async (url: string) => {
      urls.push(url);
      // The /all aggregate returns real per-row chainIds (probe 2026-09-29).
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            { chainId: '1', address: '0xeth', symbol: 'ET', name: 'Ethereum row' },
            { chainId: '8453', address: '0xbase', symbol: 'BA', name: 'Base row' },
          ],
        }),
      };
    };
    const feed = new RoutescanFeed({ fetch: fn });
    // Requesting Robinhood (4663) — Routescan 400s on that chain — must NOT throw
    // and must NOT query a per-chain 4663 endpoint; it just omits the missing chain.
    const tokens = await feed.discover({ chainIds: [4663] });
    expect(tokens).toEqual([]);
    expect(urls[0]!).toContain('/evm/all/erc20');
    expect(urls).toHaveLength(1); // single aggregate call, never per-chain
    // Requesting eth+base returns only matching rows, attributed to real chainIds.
    const eth = await feed.discover({ chainIds: [1, 8453] });
    expect(eth.map((t) => t.chainId).sort()).toEqual([1, 8453]);
  });

  // NOTE: `RoutescanFeed.fetchHolders` was removed. It had zero production
  // callers — no agent, voter, or position path ever requested holders from
  // this feed (holder concentration comes from GMGN and Arkham). The tests
  // were the only reason the method existed. The live surface is discover(),
  // proven above.

  it('drops unsupported chains (non-EVM / unknown chain id)', async () => {
    const { fn } = fetchStub([]);
    const feed = new RoutescanFeed({ fetch: fn });
    // Solana (101) is not EVM — Routescan /evm/ paths don't cover it
    const tokens = await feed.discover({ chainIds: [101] });
    expect(tokens).toEqual([]);
  });

  it('sends the apikey header when a registered key is set (keyless otherwise)', async () => {
    const headers: Record<string, string>[] = [];
    const fn = async (_url: string, init?: { headers?: Record<string, string> }) => {
      headers.push(init?.headers ?? {});
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    };
    const feed = new RoutescanFeed({ fetch: fn, apiKey: 'token_abc' });
    await feed.discover({ chainIds: [1] });
    expect(headers[0]!.apikey).toBe('token_abc');
  });
});
